// P4-F0 contract driver: freezes the 2026-09-21 architecture-review
// counterexamples (B1/B2/B7) as tracked, portable regression contracts.
//
// Usage:
//   node scripts/p4-review-contract.cjs [--only=nested,precise,category]
//        [--binary=/path/to/Chromium] [--out=/path/to/evidence-dir]
//
// The default binary resolves from the repository root to the integration
// build product. Every invocation writes to a unique evidence directory.
// Each contract asserts the DESIRED behavior; as of the review the build
// fails B1/B2/B7, so a red run is the expected frozen state until F1-F3
// land. Exit code 0 only when every selected contract passes.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { CdpPipe, closeBrowser } = require('./lib/cdp-pipe.cjs');

const root = path.resolve(__dirname, '..');
const args = Object.fromEntries(process.argv.slice(2).filter(a => a.startsWith('--')).map(a => {
  const eq = a.indexOf('='); return eq < 0 ? [a.slice(2), true] : [a.slice(2, eq), a.slice(eq + 1)];
}));
const only = args.only ? new Set(String(args.only).split(',')) : null;
const exe = path.resolve(String(args.binary || '') || path.join(
  root, 'chromium/src/out/XTraceIntegration/ChromiumX.app/Contents/MacOS/Chromium'));
const validationRoot = path.resolve(String(args.out || '') || path.join(
  root, 'chromium/src/out/XTraceIntegration/validation'));
const outDir = fs.mkdtempSync(path.join(validationRoot, 'p4-contract-'));
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('XTRACE_')));

if (!fs.existsSync(exe)) {
  console.error(`binary not found: ${exe} (pass --binary= or build out/XTraceIntegration)`);
  process.exit(2);
}

const marker = label => `JSON.stringify({reviewMarker:${JSON.stringify(label)}});`;
const makePage = (nested, fp) => '<!doctype html><body><script>' +
  'function calc(n){let s=0;for(let i=0;i<n;i++)s+=i;return s;}' + marker('before') + 'calc(20);' +
  (nested ? 'let s=document.createElement("script");s.textContent="window.reviewInner=17";document.body.appendChild(s);' : 'window.reviewInner=17;') +
  marker('after-nested') + 'window.reviewAnswer=calc(200);' + marker('after-calc') +
  (fp ? 'crypto.getRandomValues(new Uint8Array(8));' : '') + 'window.reviewDone=true;</script>';

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' });
  res.end(makePage(req.url === '/nested', req.url === '/fp'));
});

async function run(name, flags, page, extra) {
  const dir = path.join(outDir, name); fs.mkdirSync(dir);
  const trace = path.join(dir, 'trace.ndjson');
  const argv = ['--headless=new', '--remote-debugging-pipe', '--no-first-run', '--no-default-browser-check',
    '--disable-background-networking', '--disable-component-update', '--disable-sync',
    '--xtrace-enable', `--xtrace-file=${trace}`, '--xtrace-categories=reverse,fingerprint',
    ...flags, `--user-data-dir=${path.join(dir, 'profile')}`, 'about:blank'];
  fs.writeFileSync(path.join(dir, 'command.json'), JSON.stringify({ exe, args: argv, cwd: root }, null, 2));
  const fd = fs.openSync(path.join(dir, 'stderr.log'), 'w');
  const child = spawn(exe, argv, { env, stdio: ['ignore', 'ignore', fd, 'pipe', 'pipe'] }); fs.closeSync(fd);
  const crashEvents = [];
  const pipe = new CdpPipe(child, {
    onEvent: message => { if (message.method === 'Inspector.targetCrashed') crashEvents.push(message); }
  });
  const result = { name, crashEvents };
  try {
    result.caps = await pipe.send('XTrace.getCapabilities');
    try { result.precise = await pipe.send('XTrace.startCapture', { categories: 'reverse', mode: 'ignition-precise', tier: 'ignition' }); } catch (e) { result.rejection = e.message; }
    const { targetId } = await pipe.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await pipe.send('Target.attachToTarget', { targetId, flatten: true });
    await pipe.send('Page.enable', {}, sessionId);
    if (page) {
      await pipe.send('Page.navigate', { url: `http://127.0.0.1:${server.address().port}/${page}` }, sessionId);
      for (let i = 0; i < 60; i++) {
        const done = await pipe.send('Runtime.evaluate', { expression: 'window.reviewDone === true', returnByValue: true }, sessionId);
        if (done.result.value) break;
        if (i === 59) throw new Error('page did not complete');
        await new Promise(r => setTimeout(r, 50));
      }
      result.page = await pipe.send('Runtime.evaluate', { expression: '({answer:window.reviewAnswer,inner:window.reviewInner})', returnByValue: true }, sessionId);
    }
    if (extra) result.extra = await pipe.send('Runtime.evaluate', { expression: extra, returnByValue: true }, sessionId);
    if (extra === 'lifecycle-stop-first' || extra === 'lifecycle-terminate-first') {
      // R2: worker lifecycle vs capture stop, both orders. The crash
      // (Inspector.targetCrashed) is collected by the CdpPipe event hook.
      result.workerStarted = await pipe.send('Runtime.evaluate', {
        expression: "(async()=>{window.xw=new Worker(URL.createObjectURL(new Blob(['onmessage=()=>postMessage(1)'],{type:'text/javascript'})));await new Promise(r=>window.xw.onmessage=()=>r());window.xw.postMessage(0);return 'ok'})()",
        returnByValue: true, awaitPromise: true
      }, sessionId).catch(e => ({ error: String(e) }));
      const terminate = () => pipe.send('Runtime.evaluate',
          { expression: 'window.xw.terminate(); "terminated"', returnByValue: true }, sessionId)
          .catch(e => ({ error: String(e) }));
      const stop = () => pipe.send('XTrace.stopCapture').catch(e => ({ error: String(e) }));
      if (extra === 'lifecycle-terminate-first') {
        result.terminated = await terminate();
        result.stop = await stop();
      } else {
        result.stop = await stop();
        result.terminated = await terminate();
      }
      await new Promise(r => setTimeout(r, 600));  // teardown settles; crash events land here
      result.postLifecycle = await pipe.send('Runtime.evaluate',
          { expression: '2+2', returnByValue: true }, sessionId).catch(e => ({ error: String(e) }));
    }
    if (extra === 'category') {
      result.update = await pipe.send('XTrace.updateCapture', { categories: 'fingerprint' });
      await new Promise(r => setTimeout(r, 300));
      result.afterUpdate = await pipe.send('Runtime.evaluate', { expression: 'JSON.stringify({reviewCategoryMarker:7341}); navigator.platform', returnByValue: true }, sessionId);
      // F1: a Worker created AFTER the update inherits the new snapshot
      // (same process hub) — its fingerprint events carry the new generation.
      result.workerProbe = await pipe.send('Runtime.evaluate', {
        expression: "(async()=>{const src='onmessage=()=>{crypto.getRandomValues(new Uint8Array(8));postMessage(1)};crypto.getRandomValues(new Uint8Array(8))';const w=new Worker(URL.createObjectURL(new Blob([src],{type:'text/javascript'})));w.postMessage(0);await new Promise(r=>w.onmessage=()=>r());return 'ok'})()",
        returnByValue: true, awaitPromise: true
      }, sessionId).catch(e => String(e));
      // F1: a renderer spawned after the update (localhost is a different
      // site than 127.0.0.1 -> own process) must receive the config
      // backfill via its startup control-endpoint registration.
      const { targetId: t2 } = await pipe.send('Target.createTarget', { url: 'about:blank' });
      const { sessionId: s2 } = await pipe.send('Target.attachToTarget', { targetId: t2, flatten: true });
      await new Promise(r => setTimeout(r, 500));
      await pipe.send('Page.enable', {}, s2);
      await pipe.send('Page.navigate', { url: `http://localhost:${server.address().port}/fp` }, s2);
      await new Promise(r => setTimeout(r, 800));
      result.statusAfterUpdate = await pipe.send('XTrace.getCaptureStatus');
    }
    result.stop = await pipe.send('XTrace.stopCapture');
    await pipe.send('Browser.close').catch(() => {});
    await new Promise(r => {
      if (child.exitCode !== null || child.signalCode !== null) r();
      else { child.once('exit', () => r()); setTimeout(r, 5000); }
    });
    result.exit = { code: child.exitCode, signal: child.signalCode };
    if (fs.existsSync(trace)) {
      const events = fs.readFileSync(trace, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
      result.ignitionCount = events.filter(e => e.api === 'Ignition.execute').length;
      const markers = events.map((e, i) => ({ e, i })).filter(({ e }) => e.api === 'JSON.stringify' && JSON.stringify(e.args).includes('reviewMarker'));
      result.markers = markers.map(({ e, i }) => ({ i, category: e.category, generation: e.config_generation, result: e.args?.[0]?.result }));
      const from = markers.find(({ e }) => JSON.stringify(e.args).includes('after-nested'));
      const to = markers.find(({ e }) => JSON.stringify(e.args).includes('after-calc'));
      if (from && to) result.ignitionAfterNested = events.slice(from.i + 1, to.i).filter(e => e.api === 'Ignition.execute').length;
      if (extra === 'category') {
        result.categoryMarkers = events.map((e, i) => ({ e, i })).filter(({ e }) => e.api === 'JSON.stringify' && JSON.stringify(e.args).includes('reviewCategoryMarker'))
          .map(({ e, i }) => ({ i, category: e.category, generation: e.config_generation }));
        result.platformEvents = events.filter(e => e.api === 'Navigator.platform').map(e => ({ category: e.category, generation: e.config_generation }));
        const random = events.filter(e => e.api === 'Crypto.getRandomValues').map(e => ({ producer: e.producer_id, category: e.category, generation: e.config_generation }));
        result.workerRandom = random.filter(r => r.producer.startsWith('rtw:'));
        const mainEpochs = new Set(events.filter(e => e.api === 'JSON.stringify').map(e => (e.producer_id.split(':')[1] || '')));
        result.newRendererRandom = random.filter(r => r.producer.startsWith('rtx:') && !mainEpochs.has(r.producer.split(':')[1] || ''));
      }
    }
  } catch (e) { result.probeError = e.stack; }
  finally {
    if (child.exitCode === null && child.signalCode === null) { await closeBrowser(child); }
    result.exit = { code: child.exitCode, signal: child.signalCode };
    fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify(result, null, 2));
  }
  return result;
}

const contracts = [];
const contract = (name, description, pass, detail) => contracts.push({ name, description, pass, detail });

function nestedContracts(flat, nested) {
  const okFlat = flat && !flat.probeError && flat.page?.result?.value?.answer === 19900;
  contract('B1.flat-sanity', 'flat page observes ignition across the marker window', okFlat && flat.ignitionAfterNested > 0, { ignitionAfterNested: flat?.ignitionAfterNested, probeError: flat?.probeError });
  const okNested = nested && !nested.probeError && nested.page?.result?.value?.answer === 19900;
  contract('B1.nested-keeps-outer-activation', 'after a synchronous inline sub-script, outer calc(200) still emits ignition records (review saw 2224 -> 0)', okNested && nested.ignitionAfterNested > 0, { ignitionAfterNested: nested?.ignitionAfterNested, probeError: nested?.probeError });
}

function preciseEnvContracts(withoutObserver, realConflict, causalityOff) {
  const caps1 = withoutObserver?.caps?.capabilities?.limits || {};
  contract('B2a.precise-without-observer-rejected', 'startCapture(ignition-precise) must fail when --xtrace-ignition-observer was not passed at launch', !!withoutObserver?.rejection, { startResult: withoutObserver?.precise, rejection: withoutObserver?.rejection });
  contract('B2a.caps-disclose-unavailable', 'capabilities must report preciseModeAvailable=false when the observer switch is off', caps1.preciseModeAvailable === 'false' && caps1.ignitionObserverSwitch === 'false', { preciseModeAvailable: caps1.preciseModeAvailable, ignitionObserverSwitch: caps1.ignitionObserverSwitch });

  const tier = realConflict?.extra?.result?.value;
  const envIsBaseline = tier && tier.baseline === true && tier.ignition === false;
  contract('B2b.env-check-sparkplug-baseline', 'environment proof: --js-flags sparkplug override really runs baseline tier', envIsBaseline, tier);
  contract('B2b.precise-with-real-v8-conflict-rejected', 'startCapture(ignition-precise) must fail when --js-flags forces Sparkplug', !!realConflict?.rejection, { startResult: realConflict?.precise, rejection: realConflict?.rejection });

  const caps3 = causalityOff?.caps?.capabilities?.limits || {};
  contract('B2c.causality-off-caps-unavailable', 'capabilities must report preciseModeAvailable=false when causality is off', caps3.preciseModeAvailable === 'false', { preciseModeAvailable: caps3.preciseModeAvailable });
  contract('B2c.causality-off-start-rejected', 'startCapture(ignition-precise) must fail without --xtrace-causality=sync', !!causalityOff?.rejection, { rejection: causalityOff?.rejection });
}

function preciseFlagContracts(negationConflict) {
  // R3 (2026-09-22 re-review): the flags parser must keep each flag's
  // state INDEPENDENT — `--sparkplug --no-always-sparkplug` still enables
  // Sparkplug, so precise mode must reject. The merged-bool parser
  // accepted it as ignition-locked while the real tier was baseline.
  const tier = negationConflict?.extra?.result?.value;
  const envIsBaseline = tier && tier.baseline === true && tier.ignition === false;
  contract('R3.env-check-negation-still-baseline', 'environment proof: --sparkplug --no-always-sparkplug still runs baseline', envIsBaseline, tier);
  contract('R3.precise-with-independent-negation-rejected', 'startCapture(ignition-precise) must reject when sparkplug is enabled even if a LATER flag negates a DIFFERENT one', !!negationConflict?.rejection, { startResult: negationConflict?.precise, rejection: negationConflict?.rejection, capsTierLock: negationConflict?.caps?.capabilities?.limits?.tierLock });
}

function lifecycleContracts(stopFirst, terminateFirst) {
  // R2 (2026-09-22 re-review): stop must not corrupt the observer scope's
  // isolate ownership — terminating a Worker after stopCapture (and the
  // reverse order) must leave the renderer alive.
  for (const [label, run] of [['stop-then-worker-terminate', stopFirst], ['worker-terminate-then-stop', terminateFirst]]) {
    const noCrash = run && (run.crashEvents || []).length === 0;
    const pageAlive = run && !run.probeError && run.postLifecycle?.result?.value === 4;
    contract(`R2.${label}-no-renderer-crash`,
        `no Inspector.targetCrashed and the page still evaluates after ${label} (re-review saw renderer SIGSEGV in IgnitionScope::WillBeDestroyed)`,
        !!noCrash && !!pageAlive,
        { crashEvents: run?.crashEvents?.length ?? 'no-run', postLifecycle: run?.postLifecycle?.result?.value, probeError: run?.probeError, exit: run?.exit });
  }
}

function categoryContracts(cat) {
  const markers = cat?.categoryMarkers || [];
  const platform = cat?.platformEvents || [];
  const gen = String(cat?.update?.generation ?? '');
  contract('B7.post-update-events-captured', 'after updateCapture(categories:fingerprint) new fingerprint-category events arrive stamped with the update generation', platform.length > 0 && platform.some(m => String(m.generation) === gen && m.category === 'fingerprint'), { platform, gen });
  const stale = markers.filter(m => String(m.generation) === gen);
  contract('B7.reverse-filtered-post-update', 'reverse-category JSON.stringify calls must not be emitted under the new fingerprint-only generation (review saw category=reverse at the update generation)', stale.length === 0, { stale, markers, gen });
  const status = cat?.statusAfterUpdate;
  const config = status?.config || {};
  contract('B7.status-reports-config', 'getCaptureStatus discloses the applied categories alongside the generation', String(config.generation ?? '') === gen && String(config.categories || '').includes('fingerprint'), { config, gen });
  const workerRandom = cat?.workerRandom || [];
  contract('B7.worker-inherits-update', 'a Worker created after the update emits fingerprint events on the new generation (same-process hub snapshot)', cat?.workerProbe?.result?.value === 'ok' && workerRandom.length > 0 && workerRandom.every(r => String(r.generation) === gen && r.category === 'fingerprint'), { workerProbe: cat?.workerProbe?.result?.value ?? cat?.workerProbe, workerRandom, gen });
  const newRendererRandom = cat?.newRendererRandom || [];
  contract('B7.new-renderer-inherits-update', 'a renderer spawned after the update (own process) observes under the backfilled config, not generation 0', newRendererRandom.length > 0 && newRendererRandom.every(r => String(r.generation) === gen && r.category === 'fingerprint'), { newRendererRandom, gen });
}

(async () => {
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const want = name => !only || only.has(name);
  try {
    if (want('precise')) {
      const withoutObserver = await run('precise-without-observer', ['--xtrace-causality=sync']);
      const realConflict = await run('precise-with-real-v8-conflict', ['--xtrace-causality=sync', '--xtrace-ignition-observer', '--js-flags=--allow-natives-syntax --max-opt=0 --sparkplug --always-sparkplug'], null,
        '(()=>{function f(x){return x+1}; %CompileBaseline(f); return {value:f(4),baseline:%ActiveTierIsSparkplug(f),ignition:%ActiveTierIsIgnition(f)};})()');
      const causalityOff = await run('causality-off-caps', ['--xtrace-causality=off', '--xtrace-ignition-observer']);
      preciseEnvContracts(withoutObserver, realConflict, causalityOff);
      // R3: independent flag state — negating a DIFFERENT flag must not
      // clear sparkplug's.
      const negationConflict = await run('precise-flag-negation', ['--xtrace-causality=sync', '--xtrace-ignition-observer', '--js-flags=--allow-natives-syntax --max-opt=0 --sparkplug --no-always-sparkplug'], null,
        '(()=>{function f(x){return x+1}; %CompileBaseline(f); return {value:f(4),baseline:%ActiveTierIsSparkplug(f),ignition:%ActiveTierIsIgnition(f)};})()');
      preciseFlagContracts(negationConflict);
    }
    if (want('nested')) {
      const flat = await run('flat', ['--xtrace-causality=sync', '--xtrace-ignition-observer', '--js-flags=--max-opt=0'], 'flat');
      const nested = await run('nested', ['--xtrace-causality=sync', '--xtrace-ignition-observer', '--js-flags=--max-opt=0'], 'nested');
      nestedContracts(flat, nested);
    }
    if (want('category')) {
      const cat = await run('category-update', ['--xtrace-causality=sync'], 'flat', 'category');
      categoryContracts(cat);
    }
    if (want('lifecycle')) {
      // R2: both orders of stop vs worker teardown must keep the renderer
      // alive (re-review saw SIGSEGV in IgnitionScope::WillBeDestroyed).
      const stopFirst = await run('lifecycle-stop-first', ['--xtrace-causality=sync', '--xtrace-ignition-observer', '--js-flags=--max-opt=0'], 'flat', 'lifecycle-stop-first');
      const terminateFirst = await run('lifecycle-terminate-first', ['--xtrace-causality=sync', '--xtrace-ignition-observer', '--js-flags=--max-opt=0'], 'flat', 'lifecycle-terminate-first');
      lifecycleContracts(stopFirst, terminateFirst);
    }
  } finally { server.close(); }
  const failed = contracts.filter(c => !c.pass);
  const summary = { exe, outDir, contracts, failed: failed.length, total: contracts.length, ts: new Date().toISOString() };
  fs.writeFileSync(path.join(outDir, 'contracts.json'), JSON.stringify(summary, null, 2));
  for (const c of contracts) console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name}  ${c.pass ? '' : JSON.stringify(c.detail)}`);
  console.log(`${contracts.length - failed.length}/${contracts.length} contracts pass; evidence: ${outDir}`);
  process.exitCode = failed.length ? 1 : 0;
})().catch(e => { console.error(e); server.close(); process.exitCode = 1; });
