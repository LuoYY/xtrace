// N0 (review R6): unit tests for the shared CDP pipe transport against a
// fake in-process browser — session routing, timeouts, error propagation
// and teardown escalation, WITHOUT spawning Chromium.
'use strict';
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const path = require('node:path');
const { CdpPipe, closeBrowser } = require(path.resolve(__dirname, '../scripts/lib/cdp-pipe.cjs'));

// A fake child with pipe-shaped stdio (fds 3/4 as streams).
function fakeChild() {
  const toBrowser = new PassThrough();   // driver writes here (fd 3)
  const fromBrowser = new PassThrough(); // driver reads here (fd 4)
  const child = new EventEmitter();
  child.stdio = [null, null, null, toBrowser, fromBrowser];
  child.pid = 4242;
  child.exitCode = null;
  child.signalCode = null;
  child.kill = signal => { child.lastKill = signal; fake.killSignal = signal; };
  const fake = { killSignal: null };
  // Fake browser: parse NUL frames, answer by id; mirror sessionId back.
  let buffered = Buffer.alloc(0);
  toBrowser.on('data', chunk => {
    buffered = Buffer.concat([buffered, chunk]);
    let n;
    while ((n = buffered.indexOf(0)) >= 0) {
      const raw = buffered.subarray(0, n).toString(); buffered = buffered.subarray(n + 1);
      if (!raw) continue;
      const frame = JSON.parse(raw);
      let response;
      switch (frame.method) {
        case 'Echo.session':
          response = { gotSessionId: frame.sessionId };
          break;
        case 'Fail.planned':
          response = undefined;   // reply with an error object
          fromBrowser.write(JSON.stringify({ id: frame.id, error: { code: -32000, message: 'planned' } }) + '\0');
          continue;
        case 'Hang.forever':
          continue;               // no reply -> driver timeout
        default:
          response = { ok: true };
      }
      const reply = { id: frame.id, result: response };
      if (frame.sessionId !== undefined) reply.sessionId = frame.sessionId;
      fromBrowser.write(JSON.stringify(reply) + '\0');
    }
  });
  fake.child = child;
  fake.toBrowser = toBrowser;
  fake.fromBrowser = fromBrowser;
  return fake;
}

(async () => {
  // 1. sessionId is serialized and round-trips (R6 root cause).
  {
    const fake = fakeChild();
    const pipe = new CdpPipe(fake.child);
    const echo = await pipe.send('Echo.session', {}, 'SESSION-1');
    assert.strictEqual(echo.gotSessionId, 'SESSION-1');
    const none = await pipe.send('Echo.session', {});
    assert.strictEqual(none.gotSessionId, undefined);
  }
  // 2. Error responses reject with the error payload.
  {
    const fake = fakeChild();
    const pipe = new CdpPipe(fake.child, { timeoutMs: 500 });
    await assert.rejects(() => pipe.send('Fail.planned'), /planned/);
  }
  // 3. Unanswered requests time out with the method name.
  {
    const fake = fakeChild();
    const pipe = new CdpPipe(fake.child, { timeoutMs: 60 });
    await assert.rejects(() => pipe.send('Hang.forever'), /Hang.forever timeout/);
  }
  // 4. Events (no id) go to onEvent, never resolve pending requests.
  {
    const fake = fakeChild();
    const events = [];
    const pipe = new CdpPipe(fake.child, { timeoutMs: 500, onEvent: m => events.push(m) });
    fake.fromBrowser.write(JSON.stringify({ method: 'Inspector.targetCrashed', sessionId: 'S' }) + '\0');
    await new Promise(r => setTimeout(r, 30));
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].method, 'Inspector.targetCrashed');
    const ok = await pipe.send('Ok.anything');
    assert.deepStrictEqual(ok, { ok: true });
  }
  // 5. closeBrowser escalates: SIGTERM first, SIGKILL after grace.
  {
    const fake = fakeChild();
    const child = fake.child;
    const closed = closeBrowser(child, { graceMs: 50, killMs: 500 });
    await new Promise(r => setTimeout(r, 10));
    assert.strictEqual(child.lastKill, 'SIGTERM');
    // Simulate the process dying after SIGTERM.
    child.exitCode = 0; child.signalCode = null;
    child.emit('exit', 0, null);
    const outcome = await closed;
    assert.strictEqual(outcome.code, 0);
  }
  {
    const fake = fakeChild();
    const child = fake.child;
    const closed = closeBrowser(child, { graceMs: 40, killMs: 500 });
    await new Promise(r => setTimeout(r, 60));
    assert.strictEqual(child.lastKill, 'SIGKILL');
    child.exitCode = null; child.signalCode = 'SIGKILL';
    child.emit('exit', null, 'SIGKILL');
    const outcome = await closed;
    assert.strictEqual(outcome.signal, 'SIGKILL');
  }
  console.log('PASS: cdp-pipe session routing, error, timeout, events, teardown escalation');
})().catch(e => { console.error(e); process.exit(1); });
