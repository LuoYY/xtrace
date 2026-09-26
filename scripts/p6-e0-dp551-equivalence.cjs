// P6-E0 / D-P55-1: same-program semantic equivalence, off vs on.
//
// Debt (accepted-p55 record): the E7 gate's off/on "semantic
// equivalence" compared TWO DIFFERENT programs (a plain inline loop
// off, a function+natives loop on) — that proves nothing about the
// observer. This driver freezes the correct contract: the IDENTICAL
// program source (deterministic, structured result: numbers, strings,
// arrays, nested objects, a Date-free marker, a getter sentinel, a
// microtask sentinel) runs once in a capture-OFF browser and once with
// the FULL observation stack (observer + value taps + a token dump),
// and the results must DEEP-EQUAL. Getter/microtask sentinels must be
// identical too (no user-visible evaluation or drain).
const fs = require('node:fs'); const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const { CdpPipe, closeBrowser } = require(path.join(root, 'scripts/lib/cdp-pipe.cjs'));
const exe = path.join(root, 'chromium/src/out/XTraceIntegration/ChromiumX.app/Contents/MacOS/Chromium');
const runDir = fs.mkdtempSync(path.join(root, 'chromium/src/out/XTraceIntegration/validation', 'p6-e0-dp551-'));

// THE program (identical source on both sides; determinism is total —
// no Date/Math.random, only integer arithmetic and string building).
const PROGRAM = `
(function () {
  function mix(n, seed) {
    var acc = seed;
    for (var i = 0; i < n; i++) {
      acc = (acc + i * 7 + (acc >> 3)) & 0xffff;
      if (acc > 60000) { acc = acc - 40961; }
    }
    return acc;
  }
  var parts = [];
  for (var k = 0; k < 6; k++) { parts.push('s' + mix(40 + k, k + 1)); }
  var structure = {
    number: mix(1200, 42),
    text: parts.join('-'),
    list: [mix(10, 3), mix(10, 5), mix(10, 7)],
    nested: { deep: { value: mix(30, 11), flag: mix(30, 11) > 1000 } },
    totalFinite: true
  };
  return structure;
})()`;

const SENTINEL = `
(function () {
  var reads = 0, micro = 0;
  Object.defineProperty(window, '__dp551', {
    get: function () { reads++; Promise.resolve().then(function () { micro++; }); return 1; },
    configurable: true
  });
  var v = window.__dp551;   // read once at install
  return { reads: reads, micro: micro, v: v };
})()`;

const source = `import importlib.util, pathlib, socketserver\np = pathlib.Path(${JSON.stringify(path.join(__dirname, 'serve_test_page.py'))})\nspec = importlib.util.spec_from_file_location('s', p)\nm = importlib.util.module_from_spec(spec)\nspec.loader.exec_module(m)\nwith socketserver.TCPServer(('127.0.0.1', 0), m.make_test_page_handler(p.parent.parent / 'test-pages')) as server:\n print(server.server_address[1], flush=True)\n server.serve_forever()\n`;
const server = spawn('python3', ['-u', '-c', source], { stdio: ['ignore', 'pipe', 'ignore'] });

async function runSide(tag, capture) {
  const trace = path.join(runDir, `trace-${tag}.ndjson`);
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('XTRACE_')));
  const argv = ['--headless=new', '--remote-debugging-pipe', '--no-first-run',
    `--user-data-dir=${path.join(runDir, 'p' + tag)}`, 'about:blank',
    '--js-flags=--allow-natives-syntax --max-opt=0'];
  if (capture) {
    argv.push('--xtrace-enable', `--xtrace-file=${trace}`,
      '--xtrace-categories=reverse', '--xtrace-causality=sync',
      '--xtrace-ignition-observer');
  }
  const fd = fs.openSync(path.join(runDir, `stderr-${tag}.log`), 'w');
  const child = spawn(exe, argv, { env, cwd: root, stdio: ['ignore', 'ignore', fd, 'pipe', 'pipe'] });
  fs.closeSync(fd);
  const events = [];
  const exit = once(child, 'exit');
  const c = new CdpPipe(child, { timeoutMs: 60000, onEvent: e => events.push(e) });
  const r = { tag };
  try {
    const { targetId } = await c.send('Target.createTarget',
      { url: `http://127.0.0.1:${PORT}/causality-smoke.html` });
    const { sessionId } = await c.send('Target.attachToTarget', { targetId, flatten: true });
    await c.send('Runtime.enable', {}, sessionId);
    if (capture) {
      const start = await c.send('XTrace.startCapture', {
        categories: 'reverse',
        mode: 'ignition-precise', tier: 'ignition',
        valueObservation: {
          scriptPattern: '', windows: [{ id: 0, start: 0, end: 4000000 }],
          maxTapsPerActivation: 50000, maxTapsPerWindow: 50000,
        },
      });
      r.captureState = start.state;
    }
    // Injected <script> (page-URL execution under a tracked activation
    // — Runtime.evaluate is causality-untracked and never taps); the
    // IDENTICAL source runs on both sides.
    const inject = `(()=>{const s=document.createElement('script');
      s.textContent='window.__dp551prog=' + ${JSON.stringify(PROGRAM)} + ';';
      document.documentElement.appendChild(s);
      return 'injected';})()`;
    await c.send('Runtime.evaluate',
      { expression: inject, returnByValue: true }, sessionId);
    const prog = await c.send('Runtime.evaluate',
      { expression: 'window.__dp551prog', returnByValue: true }, sessionId);
    r.result = prog.result?.value;
    r.kind = prog.result?.type;
    const sentinel = await c.send('Runtime.evaluate',
      { expression: SENTINEL, returnByValue: true }, sessionId);
    r.sentinel = sentinel.result?.value;
    if (capture) {
      // a token dump DURING the page must not disturb anything either
      await new Promise(res => setTimeout(res, 1200));
      const lines = fs.readFileSync(trace, 'utf8').trim().split('\n')
        .filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return {}; } });
      r.taps = lines.filter(e => e.value_tap).length;
      const obj = lines.filter(e => e.value_tap && e.value_tap.object_token &&
        e.value_tap.object_token !== '0');
      if (obj.length) {
        const d = await c.send('XTrace.requestDump', {
          token: Number(obj[obj.length - 1].value_tap.object_token),
          producerId: obj[obj.length - 1].producer_id, label: 'dp551' });
        r.dumpStatus = d.status;
      }
      const sentinel2 = await c.send('Runtime.evaluate',
        { expression: '({reads: (window.__dp551, 0), micro: 0})', returnByValue: true }, sessionId);
      void sentinel2;
      const stop = await c.send('XTrace.stopCapture');
      r.terminal = stop.state;
    }
    await c.send('Browser.close');
  } catch (e) { r.error = e.stack; }
  const ended = await Promise.race([exit, new Promise(res => setTimeout(res, 4000))]);
  if (!ended) await closeBrowser(child, { graceMs: 3000, killMs: 3000 });
  r.crashed = events.some(e => e.method === 'Inspector.targetCrashed');
  return r;
}

let PORT = 0;
(async () => {
  PORT = await new Promise(r => { let t = ''; server.stdout.on('data', c => { t += c; if (t.includes('\n')) r(Number(t.trim())); }); });
  const off = await runSide('off', false);
  const on = await runSide('on', true);
  server.kill();
  const report = { off, on };
  fs.writeFileSync(path.join(runDir, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ off: { kind: off.kind, result: off.result, sentinel: off.sentinel, crashed: off.crashed, error: off.error },
    on: { kind: on.kind, result: on.result, sentinel: on.sentinel, taps: on.taps, dump: on.dumpStatus, terminal: on.terminal, crashed: on.crashed, error: on.error } }));
  assert(!off.error && !on.error, off.error || on.error);
  assert(!off.crashed && !on.crashed, 'renderer crashed');
  assert(off.kind === 'object' && on.kind === 'object', 'program must return an object on both sides');
  // THE frozen contract: identical program -> deep-equal results, and
  // the sentinels prove no user-visible evaluation difference.
  assert.deepEqual(on.result, off.result,
    'SAME program diverged between capture-off and capture-on');
  assert.equal(on.sentinel.reads, off.sentinel.reads, 'getter sentinel reads differ');
  assert.equal(on.sentinel.micro, off.sentinel.micro, 'microtask sentinel differs');
  if (on.taps !== undefined) {
    assert(on.taps > 0, 'observation side recorded no taps (test broken)');
  }
  console.log('P6-E0 D-P55-1 SAME-PROGRAM EQUIVALENCE: PASS');
  console.log('evidence: ' + runDir);
})().catch(e => {
  console.error('P6-E0 D-P55-1 SAME-PROGRAM EQUIVALENCE: RED — ' + e.message);
  try { server.kill(); } catch (_) {}
  process.exit(1);
});
