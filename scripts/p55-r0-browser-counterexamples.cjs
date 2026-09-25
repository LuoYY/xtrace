// P55-R0 browser counterexamples (chief review F1/F2/F3, red on the
// current implementation):
//   scope-bypass   - observer scope excludes ALL scripts; taps and
//                    metadata must be ZERO alongside the zero ignition
//                    events (defect: they leak through today).
//   negative-params- startCapture must REJECT negative window ids /
//                    budgets (defect: accepted today).
//   plan-generation - two different plans must carry different
//                    generations (defect: both report 0).
//   global-sampled  - manifest counts.sampled_out must equal the sum of
//                    producers[].sampled_out (defect: hardcoded 0 while
//                    producers report 891-scale numbers).
// Fresh output directory per run; existing evidence never touched.
const fs = require('node:fs'); const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const root = path.resolve(__dirname, '..');
const { CdpPipe, closeBrowser } = require(path.join(root, 'scripts/lib/cdp-pipe.cjs'));
const exe = path.join(root, 'chromium/src/out/XTraceIntegration/ChromiumX.app/Contents/MacOS/Chromium');
const runDir = fs.mkdtempSync(path.join(root, 'chromium/src/out/XTraceIntegration/validation', 'p55-r0b-'));
const results = [];
const check = (name, ok, detail) => {
  results.push({ case: name, ok: !!ok, detail: String(detail).slice(0, 200) });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : ' — ' + detail}`);
};
const source = `import importlib.util, pathlib, socketserver\np = pathlib.Path(${JSON.stringify(path.join(__dirname, 'serve_test_page.py'))})\nspec = importlib.util.spec_from_file_location('s', p)\nm = importlib.util.module_from_spec(spec)\nspec.loader.exec_module(m)\nwith socketserver.TCPServer(('127.0.0.1', 0), m.make_test_page_handler(p.parent.parent / 'test-pages')) as server:\n print(server.server_address[1], flush=True)\n server.serve_forever()\n`;
const server = spawn('python3', ['-u', '-c', source], { stdio: ['ignore','pipe','ignore'] });
(async () => {
  const port = await new Promise(r => { let t = ''; server.stdout.on('data', c => { t += c; if (t.includes('\n')) r(Number(t.trim())); }); });

  // --- scope-bypass -------------------------------------------------------
  {
    const dir = path.join(runDir, 'scope-bypass'); fs.mkdirSync(dir);
    const trace = path.join(dir, 'trace.ndjson');
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('XTRACE_')));
    const child = spawn(exe, ['--headless=new','--remote-debugging-pipe','--no-first-run',
      `--user-data-dir=${dir}/p`, '--xtrace-enable', `--xtrace-file=${trace}`,
      '--xtrace-categories=reverse', '--xtrace-causality=sync',
      '--xtrace-ignition-observer', '--js-flags=--allow-natives-syntax --no-maglev',
      'about:blank'], { env, cwd: root, stdio: ['ignore','ignore','ignore','pipe','pipe'] });
    const exit = once(child, 'exit');
    const c = new CdpPipe(child, { timeoutMs: 60000 });
    try {
      const { targetId } = await c.send('Target.createTarget', { url: `http://127.0.0.1:${port}/causality-smoke.html` });
      const { sessionId } = await c.send('Target.attachToTarget', { targetId, flatten: true });
      // Exclude EVERYTHING: script pattern that matches no script.
      await c.send('XTrace.updateCapture', { categories: 'reverse',
        observerScope: { contexts: [], scripts: ['impossible-match-xyz'], denyInternal: true } });
      await c.send('XTrace.startCapture', { categories: 'reverse',
        valueObservation: { scriptPattern: 'causality-smoke',
          windows: [{ id: 0, start: 0, end: 4000000 }],
          maxTapsPerActivation: 2000, maxTapsPerWindow: 512 } });
      await c.send('Runtime.enable', {}, sessionId);
      await c.send('Runtime.evaluate', { expression:
        "(()=>{const s=document.createElement('script');s.textContent=" +
        "'var a=0;for(var i=0;i<50;i++)a=(a+i)%97;window.__r=a;';" +
        "document.documentElement.appendChild(s);return window.__r;})()",
        returnByValue: true }, sessionId);
      await new Promise(r => setTimeout(r, 2500));
      await c.send('XTrace.stopCapture');
      await c.send('Browser.close');
    } catch (e) { /* keep counts */ }
    const ended = await Promise.race([exit, new Promise(r => setTimeout(r, 4000))]);
    if (!ended) await closeBrowser(child, { graceMs: 3000, killMs: 3000 });
    const lines = fs.existsSync(trace) ? fs.readFileSync(trace, 'utf8').trim()
      .split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return {}; } }) : [];
    const ign = lines.filter(e => e.api === 'Ignition.execute').length;
    const taps = lines.filter(e => e.value_tap).length;
    const meta = lines.filter(e => e.api === 'V8.bytecodeMetadata').length;
    check('r0.scope-bypass-zero-taps-metadata', ign === 0 && taps === 0 && meta === 0,
      `ignition=${ign} taps=${taps} metadata=${meta} (scope must gate ALL channels)`);
  }

  // --- negative-params + plan-generation ----------------------------------
  {
    const dir = path.join(runDir, 'negatives'); fs.mkdirSync(dir);
    const trace = path.join(dir, 'trace.ndjson');
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('XTRACE_')));
    const child = spawn(exe, ['--headless=new','--remote-debugging-pipe','--no-first-run',
      `--user-data-dir=${dir}/p`, '--xtrace-enable', `--xtrace-file=${trace}`,
      '--xtrace-categories=reverse', '--xtrace-causality=off', 'about:blank'],
      { env, cwd: root, stdio: ['ignore','ignore','ignore','pipe','pipe'] });
    const exit = once(child, 'exit');
    const c = new CdpPipe(child, { timeoutMs: 60000 });
    let negId = null, negBudget = null, gen1 = null, gen2 = null;
    try {
      gen1 = (await c.send('XTrace.startCapture', { categories: 'reverse',
        valueObservation: { scriptPattern: 'x',
          windows: [{ id: 0, start: 0, end: 10 }] } })).generation;
      try {
        await c.send('XTrace.startCapture', { categories: 'reverse',
          valueObservation: { scriptPattern: 'x',
            windows: [{ id: -5, start: 0, end: 10 }] } });
        negId = 'accepted';
      } catch (e) { negId = 'rejected'; }
      try {
        await c.send('XTrace.startCapture', { categories: 'reverse',
          valueObservation: { scriptPattern: 'x', windows: [{ id: 0, start: 0, end: 10 }],
            maxTapsPerWindow: -1 } });
        negBudget = 'accepted';
      } catch (e) { negBudget = 'rejected'; }
      gen2 = (await c.send('XTrace.startCapture', { categories: 'reverse',
        valueObservation: { scriptPattern: 'y',
          windows: [{ id: 1, start: 20, end: 30 }] } })).generation;
      await c.send('XTrace.stopCapture');
      await c.send('Browser.close');
    } catch (e) { /* recorded above */ }
    const ended = await Promise.race([exit, new Promise(r => setTimeout(r, 4000))]);
    if (!ended) await closeBrowser(child, { graceMs: 3000, killMs: 3000 });
    check('r0.negative-window-id-rejected', negId === 'rejected', `got ${negId}`);
    check('r0.negative-budget-rejected', negBudget === 'rejected', `got ${negBudget}`);
    check('r0.plan-generation-distinct',
      gen1 !== null && gen2 !== null && gen1 !== gen2, `gen1=${gen1} gen2=${gen2}`);
  }

  // --- global sampled_out == producer sum (from the E7 evidence dir) ------
  {
    const base = path.join(root, 'chromium/src/out/XTraceIntegration/validation');
    const dirs = fs.readdirSync(base)
      .filter(d => d.startsWith('p55-e7-'))
      .filter(d => fs.existsSync(path.join(base, d, 'trace.manifest.json')));
    let mismatches = [], anyProducers = false;
    for (const d of dirs) {
      const m = JSON.parse(fs.readFileSync(path.join(base, d,
        'trace.manifest.json'), 'utf8'));
      const producerSum = (m.producers || []).reduce(
        (a, p) => a + Number(p.sampled_out || 0), 0);
      const global = Number((m.counts || {}).sampled_out || 0);
      if (producerSum > 0) anyProducers = true;
      if (global !== producerSum) mismatches.push(`${d}: ${producerSum} vs ${global}`);
    }
    check('r0.global-sampled-out-consistent',
      anyProducers && mismatches.length === 0,
      mismatches.join('; ') || 'no sampled_out evidence at all');
  }

  server.kill();
  fs.writeFileSync(path.join(runDir, 'summary.json'), JSON.stringify(results, null, 2));
  console.log('evidence: ' + runDir);
  const red = results.filter(r => !r.ok);
  if (red.length) {
    console.log(`P55-R0 BROWSER COUNTEREXAMPLES: RED (${red.length}/${results.length} defects present)`);
    process.exit(1);
  }
  console.log('P55-R0 BROWSER COUNTEREXAMPLES: GREEN');
})().catch(e => { console.error(e); try { server.kill(); } catch (_) {} process.exit(1); });
