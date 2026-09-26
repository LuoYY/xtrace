// P55-E7 acceptance: the valueObservation sub-config reaches renderers
// (startCapture -> controller -> UpdateConfig push -> bridge ->
// IgnitionObserverSetTapConfig) and taps flow as ValueTap.observe fact
// events with the contract's value_tap shape. Four observation states
// (capture off / on / after stop / budget-exhausted) all keep JS
// semantics identical — observation never gates execution (P5-R1 rule).
// Budget exhaustion proves the sampled_out accounting path: taps beyond
// the per-window cap leave no value events and the manifest carries
// producers[].sampled_out > 0.
const assert = require('node:assert/strict');
const fs = require('node:fs'); const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const root = path.resolve(__dirname, '..');
const { CdpPipe, closeBrowser } = require(path.join(root, 'scripts/lib/cdp-pipe.cjs'));
const exe = path.join(root, 'chromium/src/out/XTraceIntegration/ChromiumX.app/Contents/MacOS/Chromium');
const runDir = fs.mkdtempSync(path.join(root, 'chromium/src/out/XTraceIntegration/validation', 'p55-e7-'));
const report = {};

const source = `import importlib.util, pathlib, socketserver\np = pathlib.Path(${JSON.stringify(path.join(__dirname, 'serve_test_page.py'))})\nspec = importlib.util.spec_from_file_location('s', p)\nm = importlib.util.module_from_spec(spec)\nspec.loader.exec_module(m)\nwith socketserver.TCPServer(('127.0.0.1', 0), m.make_test_page_handler(p.parent.parent / 'test-pages')) as server:\n print(server.server_address[1], flush=True)\n server.serve_forever()\n`;
const server = spawn('python3', ['-u', '-c', source], { stdio: ['ignore', 'pipe', 'ignore'] });

async function launch(opts) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('XTRACE_')));
  const argv = ['--headless=new','--remote-debugging-pipe','--no-first-run',
    `--user-data-dir=${path.join(runDir,'p'+opts.tag)}`, 'about:blank',
    '--js-flags=--allow-natives-syntax --max-opt=0'];
  if (opts.capture) {
    argv.push('--xtrace-enable', `--xtrace-file=${opts.trace}`,
      '--xtrace-categories=reverse', '--xtrace-causality=sync',
      '--xtrace-ignition-observer',
      '--js-flags=--allow-natives-syntax --max-opt=0');
  }
  const fd = fs.openSync(path.join(runDir, `stderr-${opts.tag}.log`), 'w');
  const child = spawn(exe, argv, { env, cwd: root, stdio: ['ignore','ignore',fd,'pipe','pipe'] });
  fs.closeSync(fd);
  const events = [];
  const exit = once(child, 'exit');
  const c = new CdpPipe(child, { timeoutMs: 60000, onEvent: e => events.push(e) });
  return { child, c, events, exit };
}

(async () => {
  const port = await new Promise(r => { let t = ''; server.stdout.on('data', c => { t += c; if (t.includes('\n')) r(Number(t.trim())); }); });
  // Injected <script> elements carry the PAGE URL (scope-matched for the
  // observer); Runtime.evaluate scripts are URL-less and excluded.
  const LOOP = `(()=>{const s=document.createElement('script');
    s.textContent='window.__e7=(function(){function f(n){var acc=0;for(var i=0;i<n;i++){acc=(acc+i*7)%4096;if(acc>2048)acc-=11;}return acc;}'+
      '%PrepareFunctionForOptimization(f);f(10);f(10);'+
      '%OptimizeFunctionOnNextCall(f);'+
      'const vals=[];for(let i=0;i<40;i++)vals.push(f(20));'+
      'return {allFinite:vals.every(Number.isFinite),last:vals[vals.length-1]};})();';
    document.documentElement.appendChild(s);
    return window.__e7;})()`;

  // --- state 1: capture OFF (no launch-time capture -> controller
  // absent; startCapture would fail). D-P55-1 fix: the OFF side runs
  // the IDENTICAL program source as the ON side (the old PLAIN/LOOP
  // pair compared two different programs and proved nothing).
  {
    const s = await launch({ tag: 'off' });
    const r = {};
    try {
      const { targetId } = await s.c.send('Target.createTarget', { url: `http://127.0.0.1:${port}/causality-smoke.html` });
      const { sessionId } = await s.c.send('Target.attachToTarget', { targetId, flatten: true });
      await s.c.send('Runtime.enable', {}, sessionId);
      const page = await s.c.send('Runtime.evaluate', { expression: LOOP, returnByValue: true }, sessionId);
      r.page = page.result?.value ?? (page.result?.description
        ? { evalError: page.result.description.slice(0, 120) } : undefined);
      await s.c.send('Browser.close');
    } catch (e) { r.error = e.message; }
    const ended = await Promise.race([s.exit, new Promise(res => setTimeout(res, 4000))]);
    if (!ended) await closeBrowser(s.child, { graceMs: 3000, killMs: 3000 });
    r.crashed = s.events.some(e => e.method === 'Inspector.targetCrashed');
    report.stateOff = r;
    assert(!r.crashed && r.page?.allFinite === true, JSON.stringify(r));
  }

  // --- states 2/3: capture ON via startCapture with valueObservation;
  // taps flow; after stopCapture the API still runs (no new taps needed).
  {
    const trace = path.join(runDir, 'trace.ndjson');
    const s = await launch({ tag: 'on', capture: true, trace });
    const r = {};
    try {
      const { targetId } = await s.c.send('Target.createTarget', { url: `http://127.0.0.1:${port}/causality-smoke.html` });
      const { sessionId } = await s.c.send('Target.attachToTarget', { targetId, flatten: true });
      await s.c.send('Runtime.enable', {}, sessionId);
      // NOTE: config FIRST, taps after — the LOOP optimizes after two
      // calls, so the Ignition window is exactly the warm-up.
      const start = await s.c.send('XTrace.startCapture', {
        categories: 'reverse',
        mode: 'ignition-precise', tier: 'ignition',
        valueObservation: {
          scriptPattern: 'causality-smoke',
          windows: [{ id: 0, start: 0, end: 4000000 }],
          maxTapsPerActivation: 2000,
          maxTapsPerWindow: 10,   // tiny window budget: exhaustion state
        },
      });
      assert(start.state, JSON.stringify(start));
      r.captureState = start.state;
      const page = await s.c.send('Runtime.evaluate', { expression: LOOP, returnByValue: true }, sessionId);
      r.page = page.result?.value;
      // D-P55-1: SAME program, deep-equal against the capture-OFF run.
      assert.deepEqual(r.page, report.stateOff.page,
        'same program diverged between capture off and on');
      const stop = await s.c.send('XTrace.stopCapture');
      r.terminal = stop.state;
      const after = await s.c.send('Runtime.evaluate', { expression: LOOP, returnByValue: true }, sessionId);
      r.afterStop = after.result?.value;
      assert.deepEqual(r.afterStop, report.stateOff.page,
        'same program diverged after stopCapture');
      await s.c.send('Browser.close');
    } catch (e) { r.error = e.stack; }
    const ended = await Promise.race([s.exit, new Promise(res => setTimeout(res, 4000))]);
    if (!ended) await closeBrowser(s.child, { graceMs: 3000, killMs: 3000 });
    r.crashed = s.events.some(e => e.method === 'Inspector.targetCrashed');
    report.stateOn = r;
    assert(!r.error, r.error);
    assert(!r.crashed && r.page?.allFinite === true && r.afterStop?.allFinite === true,
      JSON.stringify({ crashed: r.crashed, page: r.page, afterStop: r.afterStop }));

    const lines = fs.readFileSync(trace, 'utf8').trim().split('\n').map(l => JSON.parse(l));
    const taps = lines.filter(e => e.value_tap);
    report.valueTaps = taps.length;
    // Budget is per COMPILATION INSTANCE: each injected <script> is a
    // fresh instance, so the per-window cap applies per instance. Three
    // evaluates (stateOff/on/afterStop loop) each inject their own.
    const perInstance = {};
    for (const e of taps) perInstance[e.value_tap.instance] =
      (perInstance[e.value_tap.instance] || 0) + 1;
    report.perInstanceTaps = perInstance;
    assert(taps.length > 0, 'no taps');
    for (const [inst, n] of Object.entries(perInstance)) {
      assert(n <= 10, `instance ${inst} exceeded window budget: ${n}`);
    }
    for (const e of taps) {
      const t = e.value_tap;
      assert(e.channel === 'impl' && t.channel === 'impl', 'impl channel');
      assert(t.value_role === 'unclassified');
      assert(t.slot === 'accumulator' && t.timepoint === 'pre-dispatch');
      assert(/^\d+\/\d+$/.test(t.instance));
      assert(t.value && typeof t.value === 'object' && 'state' in t.value,
        'layer-1 encoding with explicit state');
    }
    // metadata assets still flow (D1 rides the same capture)
    assert(lines.some(e => e.api === 'V8.bytecodeMetadata'), 'D1 assets present');
    // budget exhaustion -> sampled_out accounted on the busy producer
    const manifest = JSON.parse(fs.readFileSync(path.join(runDir, 'trace.manifest.json'), 'utf8'));
    const sampled = manifest.producers.reduce((a, p) => a + Number(p.sampled_out || 0), 0);
    report.sampledOut = sampled;
    assert(sampled > 0, 'budget exhaustion must account sampled_out > 0');
    const { spawnSync } = require('node:child_process');
    const val = spawnSync('python3', [
        path.join(__dirname, 'validate_trace.py'),
        '--schema-version', '3', '--profile', 'generic-vmp', trace],
      { encoding: 'utf8', timeout: 120000 });
    report.validator = val.status;
    assert(val.status === 0, `validator: ${val.stdout}${val.stderr}`);
  }

  server.kill();
  fs.writeFileSync(path.join(runDir, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
  console.log('P55-E7 VALUE-OBSERVATION EVIDENCE: PASS');
  console.log('evidence: ' + runDir);
})().catch(e => { console.error('P55-E7 VALUE-OBSERVATION EVIDENCE: FAIL —', e.message); try { server.kill(); } catch (_) {} process.exit(1); });
