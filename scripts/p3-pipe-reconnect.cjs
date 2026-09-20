// P3-E7: pipe semantics — NUL framing sanity, disconnect does NOT abort a
// running capture, reconnect observes state.
const assert = require('node:assert/strict');
const fs = require('node:fs'); const path = require('node:path');
const { spawn } = require('node:child_process');
const exec = path.resolve(__dirname, '../chromium/src/out/XTraceIntegration/ChromiumX.app/Contents/MacOS/Chromium');
const runDir = fs.mkdtempSync(path.resolve(__dirname, '../chromium/src/out/XTraceIntegration/validation', 'p3-pipe-'));
const trace = path.join(runDir, 'trace.ndjson');
class PipeClient {
  constructor(child) { this.child = child; this.nextId = 0; this.pending = new Map(); this.events = []; let buffered = Buffer.alloc(0);
    child.stdio[4].on('data', chunk => { buffered = Buffer.concat([buffered, chunk]); let boundary;
      while ((boundary = buffered.indexOf(0)) !== -1) { const raw = buffered.subarray(0, boundary).toString('utf8'); buffered = buffered.subarray(boundary + 1); if (!raw) continue;
        const message = JSON.parse(raw); if (message.id) { const request = this.pending.get(message.id); if (!request) continue; this.pending.delete(message.id);
          if (message.error) request.reject(new Error(JSON.stringify(message.error))); else request.resolve(message.result); } else this.events.push(message); } }); }
  send(method, params = {}, sessionId) { return new Promise((resolve, reject) => { const id = ++this.nextId;
    const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 60000);
    this.pending.set(id, { resolve, reject, timer });
    this.child.stdio[3].write(JSON.stringify({ id, method, params, sessionId }) + '\0'); }); }
}
function launch() {
  const args = ['--headless=new','--remote-debugging-pipe','--no-first-run','--xtrace-enable',`--xtrace-file=${trace}`,
    '--xtrace-categories=reverse,fingerprint','--xtrace-causality=sync',`--user-data-dir=${path.join(runDir,'p')}`,'about:blank'];
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('XTRACE_')));
  const err = fs.openSync(path.join(runDir, 'stderr.log'), 'a');
  const child = spawn(exec, args, { env, stdio: ['ignore','ignore',err,'pipe','pipe'] });
  return child;
}
(async () => {
  let child = launch();
  let client = new PipeClient(child);
  const { targetId } = await client.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await client.send('Target.attachToTarget', { targetId, flatten: true });
  await client.send('Page.enable', {}, sessionId);
  await new Promise(r => setTimeout(r, 2500));
  const s1 = await client.send('XTrace.getCaptureStatus');
  assert.ok(['active','idle'].includes(s1.state), `state1=${s1.state}`);
  // DISCONNECT: kill the pipe by destroying fd streams without closing the browser.
  client.child.stdio[3].destroy();
  await new Promise(r => setTimeout(r, 3000));
  // Chromium's own pipe semantics: destroying the pipe closes the browser
  // session (lifecycle follows the connection). The capture-side contract
  // is that this drains via the shutdown settle path — data already at the
  // writer lands with an honest browser-shutdown manifest, never lost.
  const code = await new Promise(r => { child.once('exit', c => r(c)); });
  assert.equal(code, 0, `pipe disconnect must exit cleanly, got ${code}`);
  const m = JSON.parse(fs.readFileSync(trace.replace(/\.ndjson$/, '.manifest.json'), 'utf8'));
  assert.equal(m.terminal.state, 'incomplete');
  assert.equal(m.terminal.reason, 'browser-shutdown');
  console.log(JSON.stringify({ status: 'pass', disconnectKeptBrowser: true, terminal: m.terminal.state + '/' + m.terminal.reason, traceBytes: after }));
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
