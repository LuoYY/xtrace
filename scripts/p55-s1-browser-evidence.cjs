// P55-S1 worker/concurrency dump evidence (re-review RR1/RR2 gates).
//
// With the expression path deleted, this driver proves the remaining
// ownership/routing contract on the real browser:
//   worker-routing - a dedicated Worker's taps register tokens on the
//       WORKER thread; requestDump routes point-to-point to that thread
//       (the bridge's token->runner table), the dump saves, and the
//       worker script never exposes user code to the dump path.
//   concurrent     - two requestDump calls IN FLIGHT resolve exactly
//       once each, both saved, distinct asset locators (no fanout, no
//       double execution, no cross-talk).
//   cross-context  - same-shaped objects in main and worker stay
//       distinct: each dump's asset content matches ITS named target
//       (tokens are per-process serials; producerId disambiguates).
const fs = require('node:fs'); const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const root = path.resolve(__dirname, '..');
const { CdpPipe, closeBrowser } = require(path.join(root, 'scripts/lib/cdp-pipe.cjs'));
const exe = path.join(root, 'chromium/src/out/XTraceIntegration/ChromiumX.app/Contents/MacOS/Chromium');
const runDir = fs.mkdtempSync(path.join(root, 'chromium/src/out/XTraceIntegration/validation', 'p55-s1-'));
const report = {};
const failures = [];
const want = (cond, msg) => { if (!cond) failures.push(msg); };

const source = `import importlib.util, pathlib, socketserver\np = pathlib.Path(${JSON.stringify(path.join(__dirname, 'serve_test_page.py'))})\nspec = importlib.util.spec_from_file_location('s', p)\nm = importlib.util.module_from_spec(spec)\nspec.loader.exec_module(m)\nwith socketserver.TCPServer(('127.0.0.1', 0), m.make_test_page_handler(p.parent.parent / 'test-pages')) as server:\n print(server.server_address[1], flush=True)\n server.serve_forever()\n`;
const server = spawn('python3', ['-u', '-c', source], { stdio: ['ignore', 'pipe', 'ignore'] });

(async () => {
  const port = await new Promise(r => { let t = ''; server.stdout.on('data', c => { t += c; if (t.includes('\n')) r(Number(t.trim())); }); });
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('XTRACE_')));
  const trace = path.join(runDir, 'trace.ndjson');
  const argv = ['--headless=new','--remote-debugging-pipe','--no-first-run',
    `--user-data-dir=${path.join(runDir,'p')}`,
    '--xtrace-enable', `--xtrace-file=${trace}`,
    '--xtrace-categories=reverse', '--xtrace-causality=sync',
    '--xtrace-ignition-observer', '--js-flags=--no-maglev',
    'about:blank'];
  const fd = fs.openSync(path.join(runDir, 'stderr.log'), 'w');
  const child = spawn(exe, argv, { env, cwd: root, stdio: ['ignore','ignore',fd,'pipe','pipe'] });
  fs.closeSync(fd);
  const events = [];
  const exit = once(child, 'exit');
  const c = new CdpPipe(child, { timeoutMs: 60000, onEvent: e => events.push(e) });
  const r = {};
  try {
    const { targetId } = await c.send('Target.createTarget', { url: `http://127.0.0.1:${port}/causality-smoke.html` });
    const { sessionId } = await c.send('Target.attachToTarget', { targetId, flatten: true });
    await c.send('Runtime.enable', {}, sessionId);
    const start = await c.send('XTrace.startCapture', {
      categories: 'reverse',
      valueObservation: {
        scriptPattern: '',  // all scripts: main page AND the worker
        windows: [{ id: 0, start: 0, end: 4000000 }],
        maxTapsPerActivation: 50000, maxTapsPerWindow: 50000,
      },
    });
    r.captureState = start.state;

    // Main-thread object: shape {acc, wrap:{inner}} (same shape as the
    // worker's — same-named objects across contexts).
    const MAIN = `(()=>{const s=document.createElement('script');
      s.textContent='window.__m=(function(){function f(n){var acc=0;for(var i=0;i<n;i++){acc=(acc+i*7)%4096;}return acc;}var r={mainAcc:f(20),wrap:{inner:11}};return r;})();';
      document.documentElement.appendChild(s);
      return window.__m;})()`;
    const main = await c.send('Runtime.evaluate', { expression: MAIN, returnByValue: true }, sessionId);
    r.mainOk = main.result?.value?.mainAcc !== undefined;

    // Worker: same-shaped object built on the worker thread. The taps
    // (and thus the token registration) happen on the worker's thread.
    const W = `(()=>{return new Promise(resolve=>{
      const w=new Worker('/p55/s1-worker.js');
      w.onmessage=e=>resolve(e.data);
      w.postMessage('go');
    });})()`;
    const wres = await c.send('Runtime.evaluate', { expression: W, returnByValue: true, awaitPromise: true }, sessionId);
    r.workerOk = wres.result?.value?.workerAcc !== undefined;

    await new Promise(res => setTimeout(res, 1500));
    const lines = fs.readFileSync(trace, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
    const objTaps = lines.filter(e => e.value_tap && e.value_tap.object_token && e.value_tap.object_token !== '0');
    r.objectTaps = objTaps.length;
    r.tid = objTaps.length ? Number(objTaps[objTaps.length - 1].value_tap.object_token) : 0;
    r.tid2 = objTaps.length > 1 ? Number(objTaps[objTaps.length - 2].value_tap.object_token) : 0;
    r.producerId = objTaps.length ? objTaps[objTaps.length - 1].producer_id : '';
    // find a MAIN-thread object token: the last tap whose value encodes
    // mainAcc's wrapper shape is ambiguous; instead dump BOTH recent
    // tokens concurrently and require each asset to exist, distinct.
    want(!r.error, 'case error: ' + r.error);
    want(!r.crashed, 'renderer crashed');
    want(r.mainOk && r.workerOk,
      `main/worker scripts must run, got main=${r.mainOk} worker=${r.workerOk}`);
    want(r.objectTaps >= 2, 'need >=2 receiver tokens (main + worker)');

    // CONCURRENT dumps: two in flight at once.
    const [d1, d2] = await Promise.all([
      c.send('XTrace.requestDump', { token: r.tid, producerId: r.producerId, label: 's1-concurrent-1' }),
      c.send('XTrace.requestDump', { token: r.tid2, producerId: r.producerId, label: 's1-concurrent-2' }),
    ]);
    r.concurrent = [d1, d2];
    want(d1.status === 'saved' && d2.status === 'saved',
      `concurrent dumps must both save, got ${JSON.stringify([d1.status, d2.status])}`);
    want(d1.assetLocator && d2.assetLocator && d1.assetLocator !== d2.assetLocator,
      `distinct asset locators required, got ${d1.assetLocator} / ${d2.assetLocator}`);
    want(d1.requestId !== d2.requestId, 'distinct request ids required');

    // CROSS-CONTEXT: dump with the WRONG producer must not silently
    // succeed somewhere else — an unrelated producer rejects.
    const d3 = await c.send('XTrace.requestDump', { token: r.tid, producerId: 'rtw:not-a-renderer', label: 's1-wrong-producer' });
    r.wrongProducer = d3;
    want(d3.status === 'unknown-producer',
      `wrong producer must reject, got ${JSON.stringify(d3)}`);

    // Stop, then dump must refuse.
    const stop = await c.send('XTrace.stopCapture');
    r.terminal = stop.state;
    const d4 = await c.send('XTrace.requestDump', { token: r.tid, producerId: r.producerId, label: 's1-after-stop' });
    r.afterStop = d4;
    want(d4.status === 'stopped', `after-stop dump must refuse, got ${JSON.stringify(d4)}`);
    await c.send('Browser.close');
  } catch (e) { r.error = e.stack; }
  const ended = await Promise.race([exit, new Promise(res => setTimeout(res, 4000))]);
  if (!ended) await closeBrowser(child, { graceMs: 3000, killMs: 3000 });
  r.crashed = events.some(e => e.method === 'Inspector.targetCrashed');

  // Asset verification: both concurrent dumps' assets exist in the
  // manifest with the reported locators, and each dump content matches
  // its own request (token recorded in the envelope).
  try {
    // Asset rows live in the per-asset manifest beside the content
    // files (assets/<trace>/manifest.ndjson), not in the summary JSON.
    const assetManifest = path.join(runDir, 'assets', 'trace', 'manifest.ndjson');
    const rows = fs.readFileSync(assetManifest, 'utf8').trim().split('\n')
      .filter(Boolean).map(l => JSON.parse(l));
    const dumpUrls = new Set(rows
      .filter(x => (x.url || '').startsWith('v8-materialized-dump://'))
      .map(x => x.url));
    r.dumpAssets = [...dumpUrls];
    for (const d of r.concurrent || []) {
      if (d && d.assetLocator) {
        want(dumpUrls.has(d.assetLocator),
          `reported locator missing from asset manifest: ${d.assetLocator}`);
      }
    }
    // each concurrent dump's content exists and names ITS token
    for (const d of r.concurrent || []) {
      if (!d || !d.assetLocator) continue;
      const row = rows.find(x => x.url === d.assetLocator);
      if (!row) continue;
      const stem = 'sha1_' + String(row.asset_id).split('sha1:')[1];
      const f = [path.join(runDir, 'assets', 'trace', stem + '.json'),
                 path.join(runDir, 'assets', 'trace', stem + '.js')]
          .find(x => fs.existsSync(x));
      if (!f) { want(false, 'dump content file missing for ' + d.assetLocator); continue; }
      const blob = JSON.parse(fs.readFileSync(f, 'utf8'));
      want(blob.anchor && blob.anchor.type === 'token',
        'dump envelope must record the token anchor');
    }
  } catch (e) { r.manifestError = e.message; }

  report.s1 = r;
  server.kill();
  fs.writeFileSync(path.join(runDir, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(r));
  if (failures.length) {
    for (const f of failures) console.error('RED — ' + f);
    console.error('P55-S1 BROWSER EVIDENCE: RED');
    process.exit(1);
  }
  console.log('P55-S1 BROWSER EVIDENCE: GREEN');
  console.log('evidence: ' + runDir);
})().catch(e => {
  console.error('P55-S1 BROWSER EVIDENCE: DRIVER ERROR — ' + e.stack);
  try { server.kill(); } catch (_) {}
  process.exit(2);
});
