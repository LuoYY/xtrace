// P55-S2 config-interleave concurrency gate (re-review 13.2-2 hard gate).
//
// Parallel Workers x config updates interleaved: while N workers keep
// tapping on their own threads, the browser pushes successive
// updateCapture generations (category + observer-scope snapshots). The
// contract under test:
//   - no renderer crash (Inspector.targetCrashed) and page semantics
//     intact throughout;
//   - every producer settles with a watermark; the model-2 equation
//     holds (validator PASS) — config swaps never corrupt accounting;
//   - events stamp BOTH generations (evidence the snapshots were
//     actually observed, not silently lost);
//   - manifest producers[].generations[] lists per-generation eligible
//     counts (the S2 window statistics);
//   - value taps carry plan_serial (the S2 plan-revision stamp).
const fs = require('node:fs'); const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { once } = require('node:events');
const root = path.resolve(__dirname, '..');
const { CdpPipe, closeBrowser } = require(path.join(root, 'scripts/lib/cdp-pipe.cjs'));
const exe = path.join(root, 'chromium/src/out/XTraceIntegration/ChromiumX.app/Contents/MacOS/Chromium');
const runDir = fs.mkdtempSync(path.join(root, 'chromium/src/out/XTraceIntegration/validation', 'p55-s2-'));
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
    '--xtrace-ignition-observer', '--js-flags=--allow-natives-syntax --max-opt=0',
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
      mode: 'ignition-precise', tier: 'ignition',
      valueObservation: {
        scriptPattern: '',
        windows: [{ id: 0, start: 0, end: 4000000 }],
        maxTapsPerActivation: 50000, maxTapsPerWindow: 50000,
      },
    });
    r.captureState = start.state;
    r.planSerial = start.tapPlanSerial;

    // N workers tapping in loops on their own threads, driven from the
    // page; the promise resolves when all workers have spun up.
    const SPIN = `(()=>{return new Promise(resolve=>{
      const N=4, ready=[];
      window.__workers=[];
      for(let i=0;i<N;i++){
        const w=new Worker('/p55/s2-worker.js');
        window.__workers.push(w);
        w.onmessage=e=>{ if(e.data&&e.data.ready){ready.push(i); if(ready.length===N) resolve({ready:ready.length}); } };
        w.postMessage('spin');
      }
    });})()`;
    const spin = await c.send('Runtime.evaluate', { expression: SPIN, returnByValue: true, awaitPromise: true }, sessionId);
    r.workersReady = spin.result?.value?.ready;
    await new Promise(res => setTimeout(res, 700));

    // INTERLEAVE: successive config generations while the workers tap.
    const gens = [];
    for (let i = 0; i < 3; i++) {
      const upd = await c.send('XTrace.updateCapture', {
        categories: 'reverse',
        observerScope: { contexts: [], scripts: [], denyInternal: false },
      });
      gens.push(upd.generation);
      await new Promise(res => setTimeout(res, 350));
    }
    r.generationsPushed = gens;

    // page semantics intact after the interleave
    const alive = await c.send('Runtime.evaluate', {
      expression: 'window.__workers.length', returnByValue: true }, sessionId);
    r.workersAlive = alive.result?.value;
    const stop = await c.send('XTrace.stopCapture');
    r.terminal = stop.state;
    await c.send('Browser.close');
  } catch (e) { r.error = e.stack; }
  const ended = await Promise.race([exit, new Promise(res => setTimeout(res, 4000))]);
  if (!ended) await closeBrowser(child, { graceMs: 3000, killMs: 3000 });
  r.crashed = events.some(e => e.method === 'Inspector.targetCrashed');

  // settle analysis on the trace
  try {
    const lines = fs.readFileSync(trace, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
    r.events = lines.length;
    const taps = lines.filter(e => e.value_tap);
    r.taps = taps.length;
    r.planSerials = [...new Set(taps.map(e => e.value_tap.plan_serial))];
    r.eventGenerations = [...new Set(lines.map(e => e.config_generation))];
    const manifest = JSON.parse(fs.readFileSync(path.join(runDir, 'trace.manifest.json'), 'utf8'));
    r.terminalManifest = manifest.terminal?.state;
    r.coverage = manifest.observation_coverage;
    const withGens = (manifest.producers || []).filter(p => (p.generations || []).length > 0);
    r.producersWithGenerations = withGens.length;
    r.totalGenerationsRows = withGens.reduce((a, p) => a + p.generations.length, 0);
    const val = spawnSync('python3', [
        path.join(__dirname, 'validate_trace.py'),
        '--schema-version', '3', '--profile', 'generic-vmp', trace],
      { encoding: 'utf8', timeout: 120000 });
    r.validator = val.status;
  } catch (e) { r.analysisError = e.message; }

  report.s2 = r;
  server.kill();
  fs.writeFileSync(path.join(runDir, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(r));
  want(!r.error, 'case error: ' + r.error);
  want(!r.crashed, 'renderer crashed during interleave');
  want(r.workersReady === 4 && r.workersAlive === 4, `workers must survive, got ${r.workersReady}/${r.workersAlive}`);
  want(r.generationsPushed && r.generationsPushed.length === 3 &&
       new Set(r.generationsPushed).size === 3, 'three distinct generations pushed');
  want(r.taps > 0, 'no taps recorded');
  want(r.planSerials && r.planSerials.length === 1 && r.planSerials[0] === String(r.planSerial),
    `taps must stamp the plan serial, got ${JSON.stringify(r.planSerials)} vs ${r.planSerial}`);
  want(r.terminal === 'complete' && r.terminalManifest === 'complete',
    `terminal must be complete, got ${r.terminal}/${r.terminalManifest}`);
  want(r.producersWithGenerations > 0 && r.totalGenerationsRows >= 2,
    `producers[].generations[] must carry per-generation counts, got ${r.producersWithGenerations} producers / ${r.totalGenerationsRows} rows`);
  want(r.validator === 0, 'validator must pass: ' + (r.validator));
  if (failures.length) {
    for (const f of failures) console.error('RED — ' + f);
    console.error('P55-S2 CONFIG-INTERLEAVE: RED');
    process.exit(1);
  }
  console.log('P55-S2 CONFIG-INTERLEAVE: GREEN');
  console.log('evidence: ' + runDir);
})().catch(e => {
  console.error('P55-S2 CONFIG-INTERLEAVE: DRIVER ERROR — ' + e.stack);
  try { server.kill(); } catch (_) {}
  process.exit(2);
});
