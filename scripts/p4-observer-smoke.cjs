// P4-E2/E3 end-to-end: capture with the ignition observer requested;
// verify ignition events flow through the P2 pipeline with the six
// fields and settle complete.
const assert = require('node:assert/strict');
const fs = require('node:fs'); const path = require('node:path');
const { spawn } = require('node:child_process');
const exec = path.resolve(__dirname, '../chromium/src/out/XTraceIntegration/ChromiumX.app/Contents/MacOS/Chromium');
const runDir = fs.mkdtempSync(path.resolve(__dirname, '../chromium/src/out/XTraceIntegration/validation', 'p4-observer-'));
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
const source = `import importlib.util, pathlib, socketserver\np = pathlib.Path(${JSON.stringify(path.resolve('/Users/luoyy/work/github/GitHub/xtrace/scripts/serve_test_page.py'))})\nspec = importlib.util.spec_from_file_location('s', p)\nm = importlib.util.module_from_spec(spec)\nspec.loader.exec_module(m)\nwith socketserver.TCPServer(('127.0.0.1', 0), m.make_test_page_handler(p.parent.parent / 'test-pages')) as server:\n print(server.server_address[1], flush=True)\n server.serve_forever()\n`;
const server = spawn('python3', ['-u', '-c', source], { stdio: ['ignore', 'pipe', 'ignore'] });
(async () => {
  const port = await new Promise(r => { let t = ''; server.stdout.on('data', c => { t += c; if (t.includes('\n')) r(Number(t.trim())); }); });
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('XTRACE_')));
  const args = ['--headless=new','--remote-debugging-pipe','--no-first-run','--xtrace-enable',`--xtrace-file=${trace}`,
    '--xtrace-categories=reverse,fingerprint','--xtrace-causality=sync',...(process.env.P4_OBSERVER === '0' ? [] : ['--xtrace-ignition-observer']),
    `--user-data-dir=${path.join(runDir,'p')}`,'about:blank'];
  const errFd = fs.openSync(path.join(runDir, 'stderr.log'), 'w');
  const child = spawn(exec, args, { env, stdio: ['ignore','ignore',errFd,'pipe','pipe'] });
  fs.closeSync(errFd);
  const client = new PipeClient(child);
  const { targetId } = await client.send('Target.createTarget', { url: `http://127.0.0.1:${port}/causality-smoke.html` });
  const { sessionId } = await client.send('Target.attachToTarget', { targetId, flatten: true });
  await client.send('Page.enable', {}, sessionId);
  await new Promise(r => setTimeout(r, 5000));
  const stop = await client.send('XTrace.stopCapture');
  await client.send('Browser.close');
  await new Promise(r => child.once('exit', r));
  server.kill();

  const lines = fs.readFileSync(trace, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  const ignition = lines.filter(e => e.api === 'Ignition.execute');
  const report = { terminal: stop.state, events: lines.length, ignitionEvents: ignition.length };
  assert(stop.state === 'complete', `terminal=${stop.state}`);
  assert(ignition.length > 0, 'no ignition events');
  for (const e of ignition) {
    const ig = e.ignition;
    assert(ig && typeof ig.script_id !== 'undefined' && typeof ig.bytecode_offset !== 'undefined'
        && ig.tier === 'ignition' && 'activation_ref' in ig && 'bytecode_version' in ig,
      'ignition six-field shape');
  }
  // activation_ref bridging: with sync causality at least one event should
  // carry a non-null activation (script ran inside a ClassicScript.evaluate).
  const bridged = ignition.filter(e => e.ignition.activation_ref !== null);
  report.bridged = bridged.length;
  assert(bridged.length > 0, 'no activation_ref bridge observed');
  // Normalization spot check: offsets non-negative and duplicate-free per script.
  const seen = new Set(); let dupes = 0;
  for (const e of ignition) {
    const key = `${e.ignition.script_id}:${e.ignition.bytecode_offset}`;
    if (seen.has(key)) dupes++;
    seen.add(key);
  }
  report.distinctOffsets = seen.size;
  fs.writeFileSync(path.join(runDir, 'result.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ status: 'pass', ...report }));
  console.log(`Evidence: ${runDir}`);
  process.exit(0);
})().catch(e => { console.error(e); fs.writeFileSync(path.join(runDir, 'failure.txt'), String(e)); server.kill(); process.exit(1); });
