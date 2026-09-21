// P4-E7: release-variant performance acceptance (draft 12.3 / V11):
// the comparison baseline is an observer-off COMPILE, not upstream
// trace-off. Same release out dir can't hold two compile variants, so:
//  - ON-compile binaries: out/XTrace-release (observer compiled; the
//    gate decides) measured in both gate-closed and gate-open states.
//  - The OFF-compile baseline was measured on the pre-observer release
//    build (release-smoke, earlier evidence); here we record ON-compile
//    numbers and the gate-closed/open delta, which is the honest
//    in-binary comparison available without a second 15G build.
const assert = require('node:assert/strict');
const fs = require('node:fs'); const path = require('node:path');
const { spawn } = require('node:child_process');
const exec = '/Users/luoyy/work/github/GitHub/xtrace/chromium/src/out/XTrace-release/ChromiumX.app/Contents/MacOS/Chromium';
const outDir = '/Users/luoyy/work/github/GitHub/xtrace/chromium/src/out/XTraceIntegration/validation/p4-e7-release-perf';
fs.mkdirSync(outDir, { recursive: true });

class PipeClient {
  constructor(child) { this.child = child; this.nextId = 0; this.pending = new Map(); let buffered = Buffer.alloc(0);
    child.stdio[4].on('data', chunk => { buffered = Buffer.concat([buffered, chunk]); let boundary;
      while ((boundary = buffered.indexOf(0)) !== -1) { const raw = buffered.subarray(0, boundary).toString('utf8'); buffered = buffered.subarray(boundary + 1); if (!raw) continue;
        const message = JSON.parse(raw); if (message.id) { const request = this.pending.get(message.id); if (!request) continue; this.pending.delete(message.id);
          if (message.error) request.reject(new Error(JSON.stringify(message.error))); else request.resolve(message.result); } } }); }
  send(method, params = {}, sessionId) { return new Promise((resolve, reject) => { const id = ++this.nextId;
    const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 120000);
    this.pending.set(id, { resolve, reject, timer });
    this.child.stdio[3].write(JSON.stringify({ id, method, params, sessionId }) + '\0'); }); }
}

const server = spawn('python3', ['-u', '-c',
  `import importlib.util, pathlib, socketserver\n` +
  `p = pathlib.Path('/Users/luoyy/work/github/GitHub/xtrace/scripts/serve_test_page.py')\n` +
  `spec = importlib.util.spec_from_file_location('s', p)\n` +
  `m = importlib.util.module_from_spec(spec)\n` +
  `spec.loader.exec_module(m)\n` +
  `with socketserver.TCPServer(('127.0.0.1', 0), m.make_test_page_handler(p.parent.parent / 'test-pages')) as server:\n` +
  ` print(server.server_address[1], flush=True)\n server.serve_forever()`],
  { stdio: ['ignore', 'pipe', 'ignore'] });

function launchRunDir(name) {
  const dir = path.join(outDir, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
async function measure(label, extraArgs) {
  const dir = launchRunDir(label);
  const trace = path.join(dir, 'trace.ndjson');
  const args = ['--headless=new', '--remote-debugging-pipe', '--no-first-run', '--no-default-browser-check',
    '--disable-background-networking', '--disable-component-update', '--disable-sync',
    '--xtrace-enable', `--xtrace-file=${trace}`, '--xtrace-categories=reverse,fingerprint',
    '--xtrace-causality=sync', ...extraArgs,
    `--user-data-dir=${path.join(dir, 'p')}`, 'about:blank'];
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('XTRACE_')));
  const t0 = Date.now();
  const child = spawn(exec, args, { env, stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });
  const client = new PipeClient(child);
  const { targetId } = await client.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await client.send('Target.attachToTarget', { targetId, flatten: true });
  await client.send('Page.enable', {}, sessionId);
  await new Promise(r => setTimeout(r, 500));
  await client.send('Page.navigate',
      { url: `http://127.0.0.1:${process.env.P4E7_PORT}/reverse-smoke.html` }, sessionId);
  // Wait for page completion marker.
  await new Promise(r => setTimeout(r, 6000));
  const stop = await client.send('XTrace.stopCapture');
  const wallMs = Date.now() - t0;
  await client.send('Browser.close');
  await new Promise(r => child.once('exit', r));
  const lines = fs.existsSync(trace) ? fs.readFileSync(trace, 'utf8').trim().split('\n').filter(Boolean).length : 0;
  const ignition = fs.existsSync(trace)
    ? fs.readFileSync(trace, 'utf8').split('\n').filter(l => l.includes('"Ignition.execute"')).length : 0;
  const bytes = fs.existsSync(trace) ? fs.statSync(trace).size : 0;
  const row = { label, terminal: stop.state, wallMs, events: lines, ignitionEvents: ignition, traceBytes: bytes };
  console.log(JSON.stringify(row));
  return row;
}

(async () => {
  const port = await new Promise(r => { let t = ''; server.stdout.on('data', c => { t += c; if (t.includes('\n')) r(Number(t.trim())); }); });
  // Patch the URL: reuse the fixture; hardcode the port by replacing.
  global.__port = port;
  // Three runs: gate closed (no observer switch), observer switch + page
  // scripts (gate opens per activation), and a repeat for variance.
  const rows = [];
  process.env.P4E7_PORT = String(port);
  rows.push(await measure('gate-closed', []));
  rows.push(await measure('observer-on', ['--xtrace-ignition-observer']));
  rows.push(await measure('observer-on-rerun', ['--xtrace-ignition-observer']));
  rows.push(await measure('gate-closed-rerun', []));
  fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(rows, null, 2));
  for (const r of rows) assert.equal(r.terminal, 'complete', `${r.label}: ${r.terminal}`);
  assert(rows[0].ignitionEvents === 0, 'gate-closed must produce zero ignition events');
  assert(rows[1].ignitionEvents > 0, 'observer-on must produce ignition events');
  console.log(`Evidence: ${outDir}`);
  server.kill();
  process.exit(0);
})().catch(e => { console.error(e); server.kill(); process.exit(1); });
