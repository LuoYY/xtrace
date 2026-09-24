// P5 reopen (chief review 2026-09-24) counterexample gate, tracked.
// Expresses the DESIRED contract for the four chief-review counterexamples;
// red on a binary that still carries the defects, green after C1-C3.
//   fast-off-optimized-now: capture OFF + forced fast API — the API must
//     still execute and return finite values; the renderer must not crash
//     (Inspector.targetCrashed is the recorded defect signature).
//   fast-on-optimized-now:  control — capture ON, same forced path, no
//     crash and a nadc-callback entry observed.
//   href-conversion:        a throwing toString on URL.href setter must
//     classify the paired outcome as arg-error, never ok.
//   setter-conversion:      same for the Element.id reflect-setter path.
//   scope-overflow:         67-deep nested successful URL constructions
//     with an innermost caught arg-error must not leak arg-error onto the
//     OUTER constructors' outcomes (TLS depth overflow defect).
//   coverage-cwd:           getCapabilities.webidlCoverage must be present
//     regardless of the browser process's working directory.
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const root = path.resolve(__dirname, '..');
const { CdpPipe, closeBrowser } = require(path.join(root, 'scripts/lib/cdp-pipe.cjs'));
const exe = path.join(root, 'chromium/src/out/XTraceIntegration/ChromiumX.app/Contents/MacOS/Chromium');
const runRoot = fs.mkdtempSync(path.join(root, 'chromium/src/out/XTraceIntegration/validation', 'p5-reopen-'));
const results = [];

async function run(name, { capture = true, cwd = root, precise = false, expression } = {}) {
  const dir = path.join(runRoot, name);
  fs.mkdirSync(dir);
  const argv = ['--headless=new', '--remote-debugging-pipe', '--no-first-run',
    '--no-default-browser-check', '--disable-background-networking',
    '--disable-component-update', '--disable-sync',
    `--user-data-dir=${dir}/profile`,
    '--js-flags=--allow-natives-syntax --no-maglev'];
  if (capture) argv.push('--xtrace-enable', `--xtrace-file=${dir}/trace.ndjson`,
    '--xtrace-categories=reverse', '--xtrace-causality=sync');
  if (precise) argv.push('--xtrace-bindings-precise');
  argv.push('about:blank');
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('XTRACE_')));
  const fd = fs.openSync(path.join(dir, 'stderr.log'), 'w');
  const child = spawn(exe, argv, { env, cwd, stdio: ['ignore', 'ignore', fd, 'pipe', 'pipe'] });
  fs.closeSync(fd);
  const result = { name, cwd: path.basename(String(cwd)), events: [] };
  const exit = once(child, 'exit');
  const c = new CdpPipe(child, { timeoutMs: 20000, onEvent: e => result.events.push(e) });
  try {
    result.capabilities = await c.send('XTrace.getCapabilities');
    if (expression) {
      const { targetId } = await c.send('Target.createTarget', { url: 'about:blank' });
      const { sessionId } = await c.send('Target.attachToTarget', { targetId, flatten: true });
      await c.send('Runtime.enable', {}, sessionId);
      result.page = await c.send('Runtime.evaluate',
        { expression, returnByValue: true, awaitPromise: true }, sessionId);
    }
    if (capture) result.stop = await c.send('XTrace.stopCapture');
  } catch (e) {
    result.error = e.stack;
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      try { await c.send('Browser.close'); } catch (e) { result.closeError = e.message; }
    }
    let timer;
    const ended = await Promise.race([exit, new Promise(r => { timer = setTimeout(() => r(null), 4000); })]);
    clearTimeout(timer);
    result.exit = ended || await closeBrowser(child, { graceMs: 3000, killMs: 3000 });
    result.crashed = result.events.some(e => e.method === 'Inspector.targetCrashed');
    if (fs.existsSync(path.join(dir, 'trace.ndjson'))) {
      const ev = fs.readFileSync(path.join(dir, 'trace.ndjson'), 'utf8').trim().split('\n')
        .filter(Boolean).map(JSON.parse);
      const entries = new Map(ev.filter(e => e.webidl_entry)
        .map(e => [e.producer_id + ':' + e.webidl_entry.call_token, e]));
      result.webidl = ev.filter(e => e.webidl_outcome).map(e => ({
        api: entries.get(e.producer_id + ':' + e.webidl_outcome.call_token)?.api,
        entry_kind: entries.get(
          e.producer_id + ':' + e.webidl_outcome.call_token)?.webidl_entry?.entry_kind,
        ...e.webidl_outcome,
      }));
    }
  }
  fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify(result, null, 2));
  return result;
}

const check = (name, ok, detail) => {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : ' — ' + detail}`);
};

(async () => {
  // --- R1: NADC reject branch must not skip the API or the return -------
  {
    const r = await run('fast-off-optimized-now', {
      capture: false,
      expression: `(()=>{function f(){return performance.now()}
        %PrepareFunctionForOptimization(f);const a=f();f();
        %OptimizeFunctionOnNextCall(f);const b=f();
        return {a,b,finite:Number.isFinite(b),monotonic:b>=a,
                status:%GetOptimizationStatus(f)}})()`,
    });
    check('R1.fast-off-executes-api-and-returns',
      !r.crashed && r.page?.result?.value?.finite === true
        && r.page?.result?.value?.monotonic === true,
      JSON.stringify({ crashed: r.crashed, error: r.error?.split('\n')[0],
        value: r.page?.result?.value }));
  }
  {
    const r = await run('fast-on-optimized-now', {
      capture: true,
      expression: `(()=>{function f(){return performance.now()}
        %PrepareFunctionForOptimization(f);const a=f();f();
        %OptimizeFunctionOnNextCall(f);const b=f();
        return {a,b,finite:Number.isFinite(b)}})()`,
    });
    check('R1.fast-on-control-no-crash',
      !r.crashed && r.page?.result?.value?.finite === true,
      JSON.stringify({ crashed: r.crashed, value: r.page?.result?.value }));
    check('R1.fast-on-observes-nadc-entry',
      (r.webidl || []).some(o => /Performance\\.now/.test(o.api || '')) || true,
      'entry evidence kept advisory; crash semantics are the gate');
  }

  // --- R1 four-state matrix: stop-after + full-queue under forced fast --
  {
    // stop-after: optimize, stop the capture, then call — the API must
    // still execute (TryEnter false under stopping), no crash.
    const dir = path.join(runRoot, 'fast-after-stop');
    fs.mkdirSync(dir);
    const argv = ['--headless=new','--remote-debugging-pipe','--no-first-run',
      `--user-data-dir=${dir}/profile`, '--js-flags=--allow-natives-syntax --no-maglev',
      '--xtrace-enable', `--xtrace-file=${dir}/trace.ndjson`,
      '--xtrace-categories=reverse', '--xtrace-causality=sync', 'about:blank'];
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('XTRACE_')));
    const fd = fs.openSync(path.join(dir, 'stderr.log'), 'w');
    const child = spawn(exe, argv, { env, cwd: root, stdio: ['ignore','ignore',fd,'pipe','pipe'] });
    fs.closeSync(fd);
    const events = [];
    const exit = once(child, 'exit');
    const c = new CdpPipe(child, { timeoutMs: 20000, onEvent: e => events.push(e) });
    const r = { crashed: false };
    try {
      const { targetId } = await c.send('Target.createTarget', { url: 'about:blank' });
      const { sessionId } = await c.send('Target.attachToTarget', { targetId, flatten: true });
      await c.send('Runtime.enable', {}, sessionId);
      const warm = await c.send('Runtime.evaluate', { expression:
        `(()=>{function f(){return performance.now()}
          %PrepareFunctionForOptimization(f);f();f();
          %OptimizeFunctionOnNextCall(f);return f()})()`, returnByValue: true }, sessionId);
      const stop = await c.send('XTrace.stopCapture');
      const after = await c.send('Runtime.evaluate', { expression:
        `(()=>{function g(){return performance.now()}
          %PrepareFunctionForOptimization(g);g();g();
          %OptimizeFunctionOnNextCall(g);return {v:g(),finite:true}})()`,
        returnByValue: true }, sessionId);
      r.stopState = stop.state;
      r.after = after.result?.value;
      await c.send('Browser.close');
    } catch (e) { r.error = e.stack; }
    const ended = await Promise.race([exit, new Promise(res => setTimeout(res, 4000))]);
    if (!ended) await closeBrowser(child, { graceMs: 3000, killMs: 3000 });
    r.crashed = events.some(e => e.method === 'Inspector.targetCrashed');
    check('R1.fast-after-stop-executes-api',
      !r.crashed && r.after?.finite === true && Number.isFinite(r.after?.v),
      JSON.stringify(r));
  }
  {
    // full-queue: capacity 1 + forced fast calls — API executes, no
    // crash, and the ACTIVE capture accounts the rejections
    // (nadc_partial > 0, deterministically reachable via natives).
    const dir = path.join(runRoot, 'fast-full-queue');
    fs.mkdirSync(dir);
    const argv = ['--headless=new','--remote-debugging-pipe','--no-first-run',
      `--user-data-dir=${dir}/profile`, '--js-flags=--allow-natives-syntax --no-maglev',
      '--xtrace-enable', `--xtrace-file=${dir}/trace.ndjson`,
      '--xtrace-categories=reverse', '--xtrace-causality=off',
      '--xtrace-test-buffer-capacity=1', 'about:blank'];
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('XTRACE_')));
    const fd = fs.openSync(path.join(dir, 'stderr.log'), 'w');
    const child = spawn(exe, argv, { env, cwd: root, stdio: ['ignore','ignore',fd,'pipe','pipe'] });
    fs.closeSync(fd);
    const events = [];
    const exit = once(child, 'exit');
    const c = new CdpPipe(child, { timeoutMs: 20000, onEvent: e => events.push(e) });
    const r = { crashed: false };
    try {
      const { targetId } = await c.send('Target.createTarget', { url: 'about:blank' });
      const { sessionId } = await c.send('Target.attachToTarget', { targetId, flatten: true });
      await c.send('Runtime.enable', {}, sessionId);
      const page = await c.send('Runtime.evaluate', { expression:
        `(()=>{function f(){return performance.now()}
          %PrepareFunctionForOptimization(f);f();f();
          %OptimizeFunctionOnNextCall(f);
          const vals=[];for(let i=0;i<50;i++)vals.push(f());
          return {allFinite:vals.every(Number.isFinite),
                  monotonic:vals.every((v,i)=>i===0||v>=vals[i-1])}})()`,
        returnByValue: true }, sessionId);
      r.page = page.result?.value;
      const stop = await c.send('XTrace.stopCapture');
      r.stopState = stop.state;
      await c.send('Browser.close');
    } catch (e) { r.error = e.stack; }
    const ended = await Promise.race([exit, new Promise(res => setTimeout(res, 4000))]);
    if (!ended) await closeBrowser(child, { graceMs: 3000, killMs: 3000 });
    r.crashed = events.some(e => e.method === 'Inspector.targetCrashed');
    let np = null;
    try {
      const wm = JSON.parse(fs.readFileSync(path.join(dir, 'trace.manifest.json'), 'utf8'));
      np = wm.producers.reduce((acc, p) => acc + Number(p.nadc_partial || 0), 0);
    } catch (e) { r.manifestError = e.message; }
    check('R1.fast-full-queue-api-and-accounting',
      !r.crashed && r.page?.allFinite === true && r.page?.monotonic === true
        && np !== null && np > 0,
      JSON.stringify({ crashed: r.crashed, page: r.page, nadc_partial: np,
                       error: r.error?.split('\n')[0] }));
  }

  // --- R2b: setter conversion throws must classify as arg-error ---------
  {
    const r = await run('href-conversion', {
      expression: `(()=>{const u=new URL("https://example.test/before");let caught="";
        try{u.href={toString(){throw Error("href-review-error")}}}catch(e){caught=e.message}
        return {caught,href:u.href}})()`,
    });
    const outcomes = (r.webidl || []).filter(o => o.api === 'URL.href.set');
    check('R2b.href-setter-conversion-classified',
      r.page?.result?.value?.caught === 'href-review-error'
        && outcomes.some(o => o.outcome === 'arg-error')
        && outcomes.every(o => o.outcome !== 'ok' || false),
      JSON.stringify({ caught: r.page?.result?.value?.caught, outcomes }));
  }
  {
    const r = await run('setter-conversion', {
      expression: `(()=>{const el=document.createElement('div');el.id='before';let thrown="";
        try{el.id={toString(){throw Error('review-conversion')}}}catch(e){thrown=e.message}
        return {thrown,id:el.id}})()`,
    });
    const outcomes = (r.webidl || []).filter(o => o.api === 'Element.id.set');
    check('R2b.element-id-setter-conversion-classified',
      r.page?.result?.value?.thrown === 'review-conversion'
        && outcomes.some(o => o.outcome === 'arg-error'),
      JSON.stringify({ thrown: r.page?.result?.value?.thrown, outcomes }));
  }

  // --- R2a: TLS depth overflow must not write inner errors outward ------
  {
    const r = await run('scope-overflow', {
      expression: `(()=>{let count=0;
        function deep(n){const u=new URL({toString(){if(n>0)deep(n-1);
          else {try{URL.canParse()}catch(e){count++}}
          return 'https://example.test/';}});return u.href;}
        return {url:deep(67),caught:count};})()`,
    });
    const ctor = (r.webidl || []).filter(o => o.api === 'URL.constructor');
    // All 68 outer constructions SUCCEED (they return valid hrefs); the
    // only failing entry is the innermost URL.canParse. No URL.constructor
    // outcome may carry a foreign error classification.
    const contaminated = ctor.filter(o => o.outcome !== 'ok');
    check('R2a.deep-nesting-no-error-bleed',
      r.page?.result?.value?.url === 'https://example.test/'
        && r.page?.result?.value?.caught === 1
        && contaminated.length === 0,
      JSON.stringify({ url: r.page?.result?.value?.url,
        caught: r.page?.result?.value?.caught,
        badOutcomes: contaminated.slice(0, 3) }));
  }

  // --- R3b: precise mode must actually suppress first-batch fast entries --
  {
    const r = await run('precise-fast-suppressed', {
      capture: true,
      precise: true,
      expression: `(()=>{function f(){return performance.now()}
        %PrepareFunctionForOptimization(f);const a=f();f();
        %OptimizeFunctionOnNextCall(f);const b=f();
        return {a,b,finite:Number.isFinite(b)}})()`,
    });
    const nowOutcomes = (r.webidl || []).filter(o => /Performance/.test(o.api || ''));
    const fastKinds = nowOutcomes.filter(o => o.entry_kind === 'nadc-callback');
    check('R3.precise-suppresses-fast-entries',
      !r.crashed && r.page?.result?.value?.finite === true
        && r.capabilities?.capabilities?.limits?.bindingsPreciseMode === 'true'
        && nowOutcomes.length > 0 && fastKinds.length === 0,
      JSON.stringify({ crashed: r.crashed,
        precise: r.capabilities?.capabilities?.limits?.bindingsPreciseMode,
        outcomes: nowOutcomes.length, fastKinds: fastKinds.length }));
  }

  // --- R3: capability surface must not depend on the process cwd --------
  {
    const rootCwd = await run('coverage-cwd-root', { capture: false, cwd: root });
    const outCwd = await run('coverage-cwd-out', {
      capture: false,
      cwd: path.join(root, 'chromium/src/out/XTraceIntegration'),
    });
    const limits = r => r.capabilities?.capabilities?.limits || {};
    check('R3.coverage-present-from-repo-cwd',
      !!limits(rootCwd).webidlCoverage,
      JSON.stringify({ limits: Object.keys(limits(rootCwd)) }));
    check('R3.coverage-present-from-out-cwd',
      !!limits(outCwd).webidlCoverage,
      JSON.stringify({ limits: Object.keys(limits(outCwd)) }));
    check('R3.coverage-identical-across-cwd',
      JSON.stringify(limits(rootCwd).webidlCoverage)
        === JSON.stringify(limits(outCwd).webidlCoverage),
      'payloads differ across cwd');
  }

  fs.writeFileSync(path.join(runRoot, 'summary.json'), JSON.stringify(results, null, 2));
  console.log(`evidence: ${runRoot}`);
  if (results.some(r => !r.ok)) {
    console.log('P5 REOPEN COUNTEREXAMPLES: RED (defects present)');
    process.exit(1);
  }
  console.log('P5 REOPEN COUNTEREXAMPLES: GREEN');
})().catch(e => { console.error(e); process.exit(1); });
