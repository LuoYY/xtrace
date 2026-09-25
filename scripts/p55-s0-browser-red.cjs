// P55-S0 browser counterexamples (RR1 dump control, RR3 terminal),
// frozen as red tests. Each assertion expresses the DESIRED contract
// from handoff §12/§13; RED on the defect-carrying tree (71a69c1):
//
//   dump-no-user-code (RR1) - requestDump must NEVER execute user code.
//       RED on 71a69c1 (expression path: getter fired 2x, microtasks
//       drained 2x, accepted=true on a nonexistent contextId and after
//       stop). S1 deleted the expression API: the frozen invariants
//       (zero getter/microtask sentinel deltas, refusals outside a live
//       matching capture) now run against the token API, plus the
//       positive loop (tap -> object_token -> requestDump -> saved
//       asset locator) that proves the feature itself works.
//
//   controller-sampled-terminal (RR3) - a capture with real budget
//       skips (sampled_out > 0) satisfies the model-2 equation
//       eligible = enqueued + dropped + sampled_out and the validator
//       PASSES, yet the controller's OLD equation (no sampled_out
//       term) judges it incomplete/inconsistent-counts. The terminal
//       must be transport-complete (coverage stays partial).
//
// Fresh run dirs only; never touches existing evidence.
const fs = require('node:fs'); const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { once } = require('node:events');
const root = path.resolve(__dirname, '..');
const { CdpPipe, closeBrowser } = require(path.join(root, 'scripts/lib/cdp-pipe.cjs'));
const exe = path.join(root, 'chromium/src/out/XTraceIntegration/ChromiumX.app/Contents/MacOS/Chromium');
const runDir = fs.mkdtempSync(path.join(root, 'chromium/src/out/XTraceIntegration/validation', 'p55-s0-'));
const report = {};

const source = `import importlib.util, pathlib, socketserver\np = pathlib.Path(${JSON.stringify(path.join(__dirname, 'serve_test_page.py'))})\nspec = importlib.util.spec_from_file_location('s', p)\nm = importlib.util.module_from_spec(spec)\nspec.loader.exec_module(m)\nwith socketserver.TCPServer(('127.0.0.1', 0), m.make_test_page_handler(p.parent.parent / 'test-pages')) as server:\n print(server.server_address[1], flush=True)\n server.serve_forever()\n`;
const server = spawn('python3', ['-u', '-c', source], { stdio: ['ignore', 'pipe', 'ignore'] });

async function launch(tag, trace) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('XTRACE_')));
  const argv = ['--headless=new','--remote-debugging-pipe','--no-first-run',
    `--user-data-dir=${path.join(runDir,'p'+tag)}`,
    '--xtrace-enable', `--xtrace-file=${trace}`,
    '--xtrace-categories=reverse', '--xtrace-causality=sync',
    '--xtrace-ignition-observer',
    '--js-flags=--allow-natives-syntax --no-maglev',
    'about:blank'];
  const fd = fs.openSync(path.join(runDir, `stderr-${tag}.log`), 'w');
  const child = spawn(exe, argv, { env, cwd: root, stdio: ['ignore','ignore',fd,'pipe','pipe'] });
  fs.closeSync(fd);
  const events = [];
  const exit = once(child, 'exit');
  const c = new CdpPipe(child, { timeoutMs: 60000, onEvent: e => events.push(e) });
  return { child, c, events, exit };
}

(async () => {
  const port = await new Promise(r => { let t = ''; server.stdout.on('data', c => { t += c; if (t.includes('\n')) r(Number(t.trim())); }); });
  const failures = [];
  const want = (cond, msg) => { if (!cond) failures.push(msg); };

  // --- case 1: dump must not execute user code (RR1) -------------------
  // S1 update: the expression API is DELETED — requestDump(token,
  // producerId, path?, label?) routes point-to-point. The FROZEN
  // invariants stay: no getter sentinel runs, no microtask is drained,
  // targets outside a live matching capture are refused, and a REAL
  // token dump completes the positive loop (tap -> token -> dump ->
  // asset) without any user code execution.
  {
    const trace = path.join(runDir, 'dump-control.ndjson');
    const s = await launch('dump', trace);
    const r = {};
    try {
      const { targetId } = await s.c.send('Target.createTarget', { url: `http://127.0.0.1:${port}/causality-smoke.html` });
      const { sessionId } = await s.c.send('Target.attachToTarget', { targetId, flatten: true });
      await s.c.send('Runtime.enable', {}, sessionId);
      await s.c.send('Runtime.evaluate', { expression:
        'window.reviewReads=0;window.microtaskRuns=0;' +
        'Object.defineProperty(window,"reviewBox",{get(){' +
        'window.reviewReads++;Promise.resolve().then(()=>window.microtaskRuns++);return 1;}});' +
        '"sentinel-installed"', returnByValue: true }, sessionId);
      const start = await s.c.send('XTrace.startCapture', {
        categories: 'reverse',
        valueObservation: {
          scriptPattern: 'causality-smoke',  // in scope: taps DO flow
          windows: [{ id: 0, start: 0, end: 1000000 }],
          maxTapsPerActivation: 2000, maxTapsPerWindow: 2000,
        },
      });
      r.captureState = start.state;
      const LOOP = `(()=>{const s=document.createElement('script');
        s.textContent='window.__s0d=(function(){function f(n){var acc=0;for(var i=0;i<n;i++){acc=(acc+i*7)%4096;}return acc;}var r={acc:f(20),wrap:{inner:f(20)}};return r;})();';
        document.documentElement.appendChild(s);
        return window.__s0d;})()`;
      const page = await s.c.send('Runtime.evaluate', { expression: LOOP, returnByValue: true }, sessionId);
      r.pageOk = page.result?.value?.acc !== undefined;
      // wait for the taps to land in the live trace
      await new Promise(res => setTimeout(res, 1500));
      const lines = fs.readFileSync(trace, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
      const objTaps = lines.filter(e => e.value_tap && e.value_tap.object_token && e.value_tap.object_token !== '0');
      r.objectTaps = objTaps.length;
      r.producers = [...new Set(lines.filter(e => e.producer_id).map(e => e.producer_id))];
      // The dump target is the producer that OWNS the taps (a renderer
      // process with a control endpoint) — not just any producer.
      const producerId = objTaps.length
        ? objTaps[objTaps.length - 1].producer_id : '';
      const token = objTaps.length ? Number(objTaps[objTaps.length - 1].value_tap.object_token) : 0;
      // NEGATIVE 1: unknown token on the real producer
      const d1 = await s.c.send('XTrace.requestDump', {
        token: 99999999, producerId, label: 's0-unknown-token' });
      r.unknownToken = d1;
      // NEGATIVE 2: unknown producer
      const d2 = await s.c.send('XTrace.requestDump', {
        token: 1, producerId: 'no-such-producer', label: 's0-unknown-producer' });
      r.unknownProducer = d2;
      // POSITIVE: real token, own-data path
      if (token) {
        const d3 = await s.c.send('XTrace.requestDump', {
          token, producerId, label: 's0-positive' });
        r.positive = d3;
      }
      const stop = await s.c.send('XTrace.stopCapture');
      r.terminal = stop.state;
      // NEGATIVE 3: after stop
      const d4 = await s.c.send('XTrace.requestDump', {
        token: token || 1, producerId, label: 's0-after-stop' });
      r.afterStop = d4;
      const sentinel = await s.c.send('Runtime.evaluate', {
        expression: '({reads:window.reviewReads,microtasks:window.microtaskRuns})',
        returnByValue: true }, sessionId);
      r.sentinel = sentinel.result.value;
      await s.c.send('Browser.close');
    } catch (e) { r.error = e.stack; }
    const ended = await Promise.race([s.exit, new Promise(res => setTimeout(res, 4000))]);
    if (!ended) await closeBrowser(s.child, { graceMs: 3000, killMs: 3000 });
    r.crashed = s.events.some(e => e.method === 'Inspector.targetCrashed');
    report.dumpControl = r;
    console.log('dump-control: ' + JSON.stringify(r));
    // DESIRED (frozen invariants, updated to the S1 API):
    want(!r.error, 'case error: ' + r.error);
    want(!r.crashed, 'renderer crashed');
    want(r.objectTaps > 0, 'no receiver taps with object_token');
    want(r.unknownToken && r.unknownToken.status === 'unknown-token',
      'unknown token must reject with unknown-token, got ' + JSON.stringify(r.unknownToken));
    want(r.unknownProducer && r.unknownProducer.status === 'unknown-producer',
      'unknown producer must reject, got ' + JSON.stringify(r.unknownProducer));
    want(r.positive && r.positive.status === 'saved' && r.positive.assetLocator,
      'real token dump must save and report the asset locator, got ' + JSON.stringify(r.positive));
    want(r.afterStop && r.afterStop.status === 'stopped',
      'dump after stopCapture must reject with stopped, got ' + JSON.stringify(r.afterStop));
    want(r.sentinel && r.sentinel.reads === 0,
      'dump requests executed the getter sentinel ' + (r.sentinel ? r.sentinel.reads : '?') + 'x');
    want(r.sentinel && r.sentinel.microtasks === 0,
      'dump requests drained/scheduled user microtasks ' + (r.sentinel ? r.sentinel.microtasks : '?') + 'x');
  }

  // --- case 2: sampled capture must settle transport-complete (RR3) ----
  {
    const trace = path.join(runDir, 'sampled-terminal.ndjson');
    const s = await launch('sampled', trace);
    const r = {};
    try {
      const { targetId } = await s.c.send('Target.createTarget', { url: `http://127.0.0.1:${port}/causality-smoke.html` });
      const { sessionId } = await s.c.send('Target.attachToTarget', { targetId, flatten: true });
      await s.c.send('Runtime.enable', {}, sessionId);
      const start = await s.c.send('XTrace.startCapture', {
        categories: 'reverse',
        valueObservation: {
          scriptPattern: 'causality-smoke',
          windows: [{ id: 0, start: 0, end: 4000000 }],
          maxTapsPerActivation: 2000,
          maxTapsPerWindow: 10,  // tiny budget: real sampled_out > 0
        },
      });
      r.captureState = start.state;
      const LOOP = `(()=>{const s=document.createElement('script');
        s.textContent='window.__s0=(function(){function f(n){var acc=0;for(var i=0;i<n;i++){acc=(acc+i*7)%4096;if(acc>2048)acc-=11;}return acc;}'+
          'const vals=[];for(let i=0;i<40;i++)vals.push(f(20));'+
          'return {allFinite:vals.every(Number.isFinite),last:vals[vals.length-1]};})();';
        document.documentElement.appendChild(s);
        return window.__s0;})()`;
      const page = await s.c.send('Runtime.evaluate', { expression: LOOP, returnByValue: true }, sessionId);
      r.pageOk = page.result?.value?.allFinite === true;
      const stop = await s.c.send('XTrace.stopCapture');
      r.terminal = stop.state;
      r.terminalReason = stop.reason;
      await s.c.send('Browser.close');
    } catch (e) { r.error = e.stack; }
    const ended = await Promise.race([s.exit, new Promise(res => setTimeout(res, 4000))]);
    if (!ended) await closeBrowser(s.child, { graceMs: 3000, killMs: 3000 });
    r.crashed = s.events.some(e => e.method === 'Inspector.targetCrashed');
    // preconditions that hold TODAY (and must keep holding):
    const lines = fs.readFileSync(trace, 'utf8').trim().split('\n').map(l => JSON.parse(l));
    r.valueTaps = lines.filter(e => e.value_tap).length;
    const manifest = JSON.parse(fs.readFileSync(path.join(runDir, 'sampled-terminal.manifest.json'), 'utf8'));
    r.sampledOut = manifest.producers.reduce((a, p) => a + Number(p.sampled_out || 0), 0);
    const val = spawnSync('python3', [
        path.join(__dirname, 'validate_trace.py'),
        '--schema-version', '3', '--profile', 'generic-vmp', trace],
      { encoding: 'utf8', timeout: 120000 });
    r.validatorExit = val.status;
    report.sampledTerminal = r;
    console.log('sampled-terminal: ' + JSON.stringify(r));
    // preconditions that hold TODAY (and must keep holding):
    want(!r.error, 'case error: ' + r.error);
    want(!r.crashed && r.pageOk, 'page semantics broken');
    want(r.valueTaps > 0, 'no taps recorded');
    want(r.sampledOut > 0, 'budget skips missing: sampled_out=0');
    want(r.validatorExit === 0, 'validator must pass the model-2 equation');
    // DESIRED (frozen): correct equation => transport-complete terminal.
    want(r.terminal === 'complete',
      `sampled capture judged "${r.terminal}" (${r.terminalReason}) — `
      + `eligible=enqueued+dropped+sampled_out holds and validator passes, `
      + `the terminal must be transport-complete`);
  }

  server.kill();
  fs.writeFileSync(path.join(runDir, 'report.json'), JSON.stringify(report, null, 2));
  if (failures.length) {
    for (const f of failures) console.error('RED — ' + f);
    console.error('P55-S0 BROWSER COUNTEREXAMPLES: RED ('
      + failures.length + ' frozen invariants violated — expected before S1-S5)');
    process.exit(1);
  }
  console.log('P55-S0 BROWSER COUNTEREXAMPLES: all frozen invariants hold (unexpected — fixes already landed?)');
  console.log('evidence: ' + runDir);
})().catch(e => {
  console.error('P55-S0 BROWSER COUNTEREXAMPLES: DRIVER ERROR — ' + e.stack);
  try { server.kill(); } catch (_) {}
  try { fs.writeFileSync(path.join(runDir, 'report.json'), JSON.stringify(report, null, 2)); } catch (_) {}
  process.exit(2);
});
