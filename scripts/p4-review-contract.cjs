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

class Pipe {
  constructor(child) {
    this.child = child; this.id = 0; this.pending = new Map(); let buf = Buffer.alloc(0);
    child.stdio[4].on('data', chunk => {
      buf = Buffer.concat([buf, chunk]); let n;
      while ((n = buf.indexOf(0)) >= 0) {
        const raw = buf.subarray(0, n).toString(); buf = buf.subarray(n + 1); if (!raw) continue;
        const msg = JSON.parse(raw), req = this.pending.get(msg.id);
        if (req) { clearTimeout(req.timer); this.pending.delete(msg.id); msg.error ? req.reject(new Error(JSON.stringify(msg.error))) : req.resolve(msg.result); }
      }
    });
    child.once('exit', () => { for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('browser exit')); } this.pending.clear(); });
  }
  send(method, params = {}, sessionId) {
    return new Promise((resolve, reject) => {
      const id = ++this.id; const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(method + ' timeout')); }, 30000);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdio[3].write(JSON.stringify({ id, method, params, sessionId }) + '\0');
    });
  }
}

const marker = label => `JSON.stringify({reviewMarker:${JSON.stringify(label)}});`;
const makePage = nested => '<!doctype html><body><script>' +
  'function calc(n){let s=0;for(let i=0;i<n;i++)s+=i;return s;}' + marker('before') + 'calc(20);' +
  (nested ? 'let s=document.createElement("script");s.textContent="window.reviewInner=17";document.body.appendChild(s);' : 'window.reviewInner=17;') +
  marker('after-nested') + 'window.reviewAnswer=calc(200);' + marker('after-calc') + 'window.reviewDone=true;</script>';

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' });
  res.end(makePage(req.url === '/nested'));
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
  const exit = once(child, 'exit'), pipe = new Pipe(child), result = { name };
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
    if (extra === 'category') {
      result.update = await pipe.send('XTrace.updateCapture', { categories: 'fingerprint' });
      await new Promise(r => setTimeout(r, 300));
      result.afterUpdate = await pipe.send('Runtime.evaluate', { expression: 'JSON.stringify({reviewCategoryMarker:7341}); navigator.platform', returnByValue: true }, sessionId);
      result.statusAfterUpdate = await pipe.send('XTrace.getCaptureStatus');
    }
    result.stop = await pipe.send('XTrace.stopCapture');
    await pipe.send('Browser.close'); result.exit = await exit;
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
      }
    }
  } catch (e) { result.probeError = e.stack; }
  finally {
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await exit; }
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
  } finally { server.close(); }
  const failed = contracts.filter(c => !c.pass);
  const summary = { exe, outDir, contracts, failed: failed.length, total: contracts.length, ts: new Date().toISOString() };
  fs.writeFileSync(path.join(outDir, 'contracts.json'), JSON.stringify(summary, null, 2));
  for (const c of contracts) console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name}  ${c.pass ? '' : JSON.stringify(c.detail)}`);
  console.log(`${contracts.length - failed.length}/${contracts.length} contracts pass; evidence: ${outDir}`);
  process.exitCode = failed.length ? 1 : 0;
})().catch(e => { console.error(e); server.close(); process.exitCode = 1; });
