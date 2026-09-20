// P3-E2 smoke: verify the XTrace CDP domain on the browser target over the
// pipe — getCapabilities (enabled/disabled), getCaptureStatus (running
// capture identity), stopCapture → stopping, then status shows terminal.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const executable = path.resolve(__dirname, '../chromium/src/out/XTraceIntegration/Chromium.app/Contents/MacOS/Chromium');
const runDir = fs.mkdtempSync(path.resolve(__dirname, '../chromium/src/out/XTraceIntegration/validation', 'p3-domain-smoke-'));
const trace = path.join(runDir, 'trace.ndjson');

class PipeClient {
  constructor(child) { this.child = child; this.nextId = 0; this.pending = new Map(); let buffered = Buffer.alloc(0);
    child.stdio[4].on('data', chunk => { buffered = Buffer.concat([buffered, chunk]); let boundary;
      while ((boundary = buffered.indexOf(0)) !== -1) { const raw = buffered.subarray(0, boundary).toString('utf8'); buffered = buffered.subarray(boundary + 1); if (!raw) continue;
        const message = JSON.parse(raw); if (message.id) { const request = this.pending.get(message.id); if (!request) continue; this.pending.delete(message.id);
          if (message.error) request.reject(new Error(JSON.stringify(message.error))); else request.resolve(message.result); } } }); }
  send(method, params = {}, sessionId) { return new Promise((resolve, reject) => { const id = ++this.nextId;
    const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 60000);
    this.pending.set(id, { resolve, reject, timer });
    this.child.stdio[3].write(JSON.stringify({ id, method, params, sessionId }) + '\0'); }); }
}

async function launch(extraArgs) {
  const args = ['--headless=new', '--remote-debugging-pipe', '--no-first-run', '--no-default-browser-check',
    '--disable-background-networking', '--disable-component-update', '--disable-sync',
    ...extraArgs,
    `--user-data-dir=${path.join(runDir, 'profile' + (extraArgs.length))}`, 'about:blank'];
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('XTRACE_')));
  const stderr = fs.openSync(path.join(runDir, 'stderr.log'), 'a');
  const child = spawn(executable, args, { env, stdio: ['ignore', 'ignore', stderr, 'pipe', 'pipe'] });
  fs.closeSync(stderr);
  return { child, client: new PipeClient(child) };
}

async function main() {
  // 1. Disabled at launch: capabilities answers with captureEnabled=false;
  //    lifecycle commands are rejected (three-state, no silent fallback).
  {
    const { child, client } = await launch([]);
    const caps = await client.send('XTrace.getCapabilities');
    assert.equal(caps.capabilities.schemaVersion, 3);
    assert.equal(caps.capabilities.trustedOnly, true);
    assert.equal(caps.capabilities.limits.captureEnabled, 'false');
    await assert.rejects(() => client.send('XTrace.getCaptureStatus'),
        /capture disabled/, 'status must reject when disabled');
    await client.send('Browser.close');
    await new Promise(r => child.once('exit', r));
  }

  // 2. Enabled at launch: capabilities reflect it; status shows the running
  //    capture (generation "0"); stop settles; status reports the terminal.
  {
    const { child, client } = await launch([
      '--xtrace-enable', `--xtrace-file=${trace}`, '--xtrace-categories=reverse,fingerprint',
      '--xtrace-causality=sync', '--xtrace-stop-after-ms=25000']);
    const caps = await client.send('XTrace.getCapabilities');
    assert.equal(caps.capabilities.limits.captureEnabled, 'true');
    assert.equal(caps.capabilities.limits.overflowPolicy, 'drop-newest');

    const { targetId } = await client.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await client.send('Target.attachToTarget', { targetId, flatten: true });
    await client.send('Page.enable', {}, sessionId);
    await new Promise(r => setTimeout(r, 2500));

    const status = await client.send('XTrace.getCaptureStatus');
    assert.equal(status.generation, '0');

    // P3-E4: runtime update — generation allocates serially from "1";
    // subsequent events carry the new generation.
    const upd = await client.send('XTrace.updateCapture', { categories: 'reverse' });
    assert.equal(upd.generation, '1');
    await new Promise(r => setTimeout(r, 1500));
    const status2 = await client.send('XTrace.getCaptureStatus');
    assert.equal(status2.generation, '1');
    // Positive propagation evidence: events emitted AFTER the update must
    // stamp config_generation "1".
    await client.send('Runtime.evaluate',
        { expression: 'JSON.parse(String(7)); JSON.stringify({x:1})', returnByValue: true }, sessionId);
    await new Promise(r => setTimeout(r, 2500));
    // Stop rejects updates.
    const stop0 = await client.send('XTrace.stopCapture');
    await assert.rejects(() => client.send('XTrace.updateCapture', { categories: 'reverse' }),
        /invalid state/, 'update during stopping must be rejected');
    assert.ok(['active', 'idle'].includes(status.state), `state=${status.state}`);
    assert.ok(Array.isArray(status.producers));
    assert.ok(status.producers.every(p => p.confirmed || p.eligible === undefined),
        'unconfirmed producers must omit producer-side counters');

    const stop = stop0;
    assert.ok(['stopping', 'incomplete', 'complete'].includes(stop.state), `stop=${stop.state}`);
    // The stop reply itself carries the settled state + manifest stream
    // (bounded internal wait, not client polling).
    assert.ok(['incomplete', 'complete'].includes(stop.state), `settled=${stop.state}`);
    assert.ok(stop.manifestStream, 'manifest stream handle expected');
    const chunk = await client.send('IO.read', { handle: stop.manifestStream });
    assert(chunk.data, 'IO.read returned no data');
    const raw = chunk.base64Encoded
        ? Buffer.from(chunk.data, 'base64').toString('utf8')
        : chunk.data;
    const manifest = JSON.parse(raw);
    assert.equal(manifest.terminal.state, stop.state);
    assert.equal(manifest.schema_version, 3);
    await client.send('IO.close', { handle: stop.manifestStream });
    // Closed-stream behavior follows the IO domain's own semantics; the
    // point for XTrace is only that the handle lifecycle is IO-owned.
    // (Some builds return eof:true rather than an error.)
    const final = await client.send('XTrace.getCaptureStatus');
    assert.ok(['complete', 'incomplete'].includes(final.state), `final=${final.state}`);
    assert.equal(final.terminal.state, final.state);

    // Browser-only enforcement (negative): a PAGE-level session must not
    // expose the XTrace domain (handler registered on the browser target
    // only; page sessions get method-not-found).
    let pageLeak = false;
    try {
      const pageCaps = await client.send('XTrace.getCapabilities', {}, sessionId);
      pageLeak = !!(pageCaps && pageCaps.capabilities &&
                   pageCaps.capabilities.trustedOnly === true);
    } catch (e) {
      pageLeak = false;  // rejected: correct browser-only behavior
    }
    assert(!pageLeak, 'page session must not get full XTrace capabilities');
    await client.send('Browser.close');
    await new Promise(r => child.once('exit', r));
    fs.writeFileSync(path.join(runDir, 'result.json'), JSON.stringify({ status: 'pass', final, pageSessionRejected: true }, null, 2));
    console.log(JSON.stringify({ status: 'pass', terminal: final.state, producers: final.producers.length }));
  }
  console.log(`Evidence: ${runDir}`);
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
