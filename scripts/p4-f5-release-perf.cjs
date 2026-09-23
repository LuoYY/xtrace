// P4-F5 release performance acceptance (review B6; R6 hardening).
//
// Three states from matched builds (upstream print tracing OFF in both):
//   A = out/XTrace-release-A      observer NOT compiled
//   B = out/XTrace-release        observer compiled, not requested
//   C = out/XTrace-release        observer compiled AND requested
// All runs share tier/causality flags (--js-flags=--max-opt=0,
// --xtrace-causality=sync). Note C additionally runs with the observer
// environment's code-cache disable — that is intrinsic to state C and is
// disclosed per run rather than claimed as a controlled variable.
//
// Every run: unique directory, hardened v3 validator FIRST, workload
// RESULT assertion (not just completion), reliable process teardown,
// stderr retained. Distributions over repeats.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { CdpPipe, closeBrowser } = require('./lib/cdp-pipe.cjs');

const root = path.resolve(__dirname, '..');
const validation = path.resolve(root, 'chromium/src/out/XTraceIntegration/validation');
const outDir = fs.mkdtempSync(path.join(validation, 'p4-f5-perf-'));
const validatorPy = path.join(root, 'scripts', 'validate_trace.py');
const REPEATS = Number(process.env.F5_REPEATS || 5);
if (!Number.isInteger(REPEATS) || REPEATS <= 0) {
  console.error(`F5_REPEATS must be a positive integer (got ${process.env.F5_REPEATS})`);
  process.exit(2);
}
const WORKLOAD_LOOPS = 30;
// 30 * sum(i%7 for i in 0..3999): fixed expected answer, checked per run.
const EXPECTED_ANSWER = 359820;
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('XTRACE_')));

const binaries = {
  A: path.resolve(root, 'chromium/src/out/XTrace-release-A/ChromiumX.app/Contents/MacOS/Chromium'),
  B: path.resolve(root, 'chromium/src/out/XTrace-release/ChromiumX.app/Contents/MacOS/Chromium'),
};

const page = '<!doctype html><body><script>' +
  'function calc(n){let s=0;for(let i=0;i<n;i++)s+=(i%7);return s}' +
  `let acc=0;for(let r=0;r<${WORKLOAD_LOOPS};r++){acc+=calc(4000);JSON.stringify({reviewMarker:r,acc});}` +
  'window.reviewAnswer=acc;window.reviewDone=true;</script>';
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' });
  res.end(page);
});

function sha256(file) {
  return 'sha256:' + createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}
function stats(xs) {
  const s = [...xs].sort((a, b) => a - b);
  return { min: s[0], median: s[Math.floor(s.length / 2)], max: s[s.length - 1], all: xs };
}
function sampleRSS(pid) {
  try {
    const out = spawnSync('/bin/ps', ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf8' });
    return Number((out.stdout || '').trim().split('\n')[0]) || 0;
  } catch { return 0; }
}
function normalizedArgs(file) {
  return fs.readFileSync(file, 'utf8').split('\n').map(l => l.trim())
      .filter(l => l && !l.startsWith('#'))
      // GN is whitespace-insensitive around '=' — normalize before compare.
      .map(l => l.replace(/\s*=\s*/, '='));
}

async function oneRun(state, repeat) {
  const exe = state === 'A' ? binaries.A : binaries.B;
  const dir = path.join(outDir, `${state}-${repeat}`); fs.mkdirSync(dir);
  const trace = path.join(dir, 'trace.ndjson');
  const argv = ['--headless=new', '--remote-debugging-pipe', '--no-first-run', '--no-default-browser-check',
    '--disable-background-networking', '--disable-component-update', '--disable-sync',
    '--xtrace-enable', `--xtrace-file=${trace}`, '--xtrace-categories=reverse,fingerprint,internal',
    '--xtrace-causality=sync', '--js-flags=--max-opt=0',
    ...(state === 'C' ? ['--xtrace-ignition-observer'] : []),
    `--user-data-dir=${path.join(dir, 'profile')}`, 'about:blank'];
  fs.writeFileSync(path.join(dir, 'command.json'), JSON.stringify({ exe, argv }, null, 2));
  const stderrFd = fs.openSync(path.join(dir, 'stderr.log'), 'w');
  const child = spawn(exe, argv, { env, stdio: ['ignore', 'ignore', stderrFd, 'pipe', 'pipe'] });
  const pipe = new CdpPipe(child);
  let peakRSS = 0;
  const sampler = setInterval(() => { peakRSS = Math.max(peakRSS, sampleRSS(child.pid)); }, 100);
  const run = { state, repeat, exe: sha256(exe) };
  try {
    const t0 = process.hrtime.bigint();
    await pipe.send('Browser.getVersion');
    run.startupMs = Number(process.hrtime.bigint() - t0) / 1e6;
    const { targetId } = await pipe.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await pipe.send('Target.attachToTarget', { targetId, flatten: true });
    await pipe.send('Page.enable', {}, sessionId);
    const w0 = process.hrtime.bigint();
    await pipe.send('Page.navigate', { url: `http://127.0.0.1:${server.address().port}/workload` }, sessionId);
    let done = false, answer;
    for (let i = 0; i < 400 && !done; i++) {
      const reply = await pipe.send('Runtime.evaluate',
          { expression: 'window.reviewDone === true ? window.reviewAnswer : false', returnByValue: true }, sessionId);
      if (reply.result.value !== false) { done = true; answer = reply.result.value; }
      else await new Promise(r => setTimeout(r, 25));
    }
    const w1 = process.hrtime.bigint();
    assert(done, `${state}-${repeat}: workload never completed`);
    assert.strictEqual(answer, EXPECTED_ANSWER,
        `${state}-${repeat}: workload answer ${answer} != ${EXPECTED_ANSWER} (JS semantics broken)`);
    run.workloadMs = Number(w1 - w0) / 1e6;
    const stop0 = process.hrtime.bigint();
    const stop = await pipe.send('XTrace.stopCapture');
    run.stopMs = Number(process.hrtime.bigint() - stop0) / 1e6;
    run.terminal = stop.state;
    await pipe.send('Browser.close').catch(() => {});
  } finally {
    clearInterval(sampler);
    const outcome = await closeBrowser(child);
    fs.closeSync(stderrFd);
    run.exit = outcome;
    fs.writeFileSync(path.join(dir, 'run.json'), JSON.stringify(run, null, 2));
  }
  assert.strictEqual(run.exit.code, 0, `${state}-${repeat}: browser exit ${JSON.stringify(run.exit)}`);
  assert.strictEqual(run.terminal, 'complete', `${state}-${repeat}: terminal ${run.terminal}`);
  run.peakRSSKB = peakRSS;  // browser process only (documented scope)

  const v = spawnSync('python3', [validatorPy, '--schema-version', '3', '--expect', 'JSON.stringify', trace],
      { encoding: 'utf8', timeout: 120000 });
  run.validatorExit = v.status;
  if (v.status !== 0) {
    fs.writeFileSync(path.join(dir, 'validator.txt'), (v.stdout || '') + (v.stderr || ''));
    throw new Error(`${state}-${repeat}: validator failed: ${(v.stderr || v.stdout || '').slice(0, 400)}`);
  }
  // Buffer-based counting: state C traces can exceed Node's max string
  // length (~512MB) — never decode the whole file to a JS string.
  const buf = fs.readFileSync(trace);
  run.events = 0;
  run.ignition = 0;
  {
    let pos = -1;
    run.events = 0;
    while ((pos = buf.indexOf(0x0a, pos + 1)) !== -1) { run.events += 1; }
    if (buf.length && buf[buf.length - 1] !== 0x0a) { run.events += 1; }
    const needle = Buffer.from('"api":"Ignition.execute"');
    let p2 = 0;
    while ((p2 = buf.indexOf(needle, p2)) !== -1) { run.ignition += 1; p2 += needle.length; }
  }
  run.traceBytes = buf.length;
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'trace.manifest.json'), 'utf8'));
  run.dropped = Number(manifest.counts?.dropped ?? -1);
  run.failed = Number(manifest.counts?.failed ?? -1);
  run.written = Number(manifest.counts?.written ?? -1);
  run.isDebug = manifest.build?.is_debug;
  run.dcheckAlwaysOn = manifest.build?.dcheck_always_on;
  assert.strictEqual(run.dropped, 0, `${state}-${repeat}: dropped ${run.dropped}`);
  if (state === 'C') assert(run.ignition > 0, `${state}-${repeat}: observer-on with zero ignition events`);
  if (state !== 'C') assert.strictEqual(run.ignition, 0, `${state}-${repeat}: ignition without observer request`);
  fs.writeFileSync(path.join(dir, 'run.json'), JSON.stringify(run, null, 2));
  return run;
}

(async () => {
  for (const exe of Object.values(binaries)) {
    if (!fs.existsSync(exe)) { console.error(`binary missing: ${exe}`); process.exit(2); }
  }
  // A/B args must differ ONLY in the observer compile flag (R6 binding).
  const argsA = normalizedArgs(path.resolve(root, 'chromium/src/out/XTrace-release-A/args.gn'));
  const argsB = normalizedArgs(path.resolve(root, 'chromium/src/out/XTrace-release/args.gn'));
  const diff = argsA.filter(l => !argsB.includes(l)).concat(argsB.filter(l => !argsA.includes(l)));
  assert.deepStrictEqual(diff.sort(),
      ['v8_enable_xtrace_ignition_observer=false', 'v8_enable_xtrace_ignition_observer=true'].sort(),
      `A/B args differ beyond the observer flag: ${JSON.stringify(diff)}`);

  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const results = { A: [], B: [], C: [] };
  try {
    for (let i = 1; i <= REPEATS; i++) {
      for (const state of ['A', 'B', 'C']) {
        const run = await oneRun(state, i);
        results[state].push(run);
        console.log(`${state}-${i}: workload=${run.workloadMs.toFixed(0)}ms stop=${run.stopMs.toFixed(0)}ms events=${run.events} ignition=${run.ignition} rss=${run.peakRSSKB}KB is_debug=${run.isDebug}`);
      }
    }
  } finally { server.close(); }

  const summary = {
    ts: new Date().toISOString(),
    repeats: REPEATS,
    workload: { loops: WORKLOAD_LOOPS, expectedAnswer: EXPECTED_ANSWER, asserted: true },
    binaries: { A: sha256(binaries.A), B: sha256(binaries.B) },
    frameworks: {
      A: sha256(path.resolve(binaries.A, '../../Frameworks/Chromium Framework.framework/Chromium Framework')),
      B: sha256(path.resolve(binaries.B, '../../Frameworks/Chromium Framework.framework/Chromium Framework')),
    },
    sourceHead: spawnSync('git', ['-C', path.join(root, 'chromium/src'), 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim(),
    patches: fs.readdirSync(path.join(root, 'patches')).filter(f => f.endsWith('.patch')).sort()
        .map(f => ({ f, sha256: sha256(path.join(root, 'patches', f)) })),
    driver: sha256(__filename),
    cdpPipeModule: sha256(path.join(__dirname, 'lib', 'cdp-pipe.cjs')),
    argsGn: { A: argsA, B: argsB },
    rssScope: 'browser process only (renderer/worker not aggregated)',
    stateCExtra: 'observer environment also disables code cache (intrinsic, disclosed)',
    distributions: {},
    runs: results,
  };
  for (const state of ['A', 'B', 'C']) {
    const rs = results[state];
    summary.distributions[state] = {
      workloadMs: stats(rs.map(r => r.workloadMs)),
      stopMs: stats(rs.map(r => r.stopMs)),
      startupMs: stats(rs.map(r => r.startupMs)),
      peakRSSKB: stats(rs.map(r => r.peakRSSKB)),
      events: stats(rs.map(r => r.events)),
      droppedAllZero: rs.every(r => r.dropped === 0),
      failedAllZero: rs.every(r => r.failed === 0),
    };
  }
  console.log('\n== Distributions (min/median/max over ' + REPEATS + ') ==');
  for (const state of ['A', 'B', 'C']) {
    const d = summary.distributions[state];
    console.log(`${state}: workload ${d.workloadMs.min.toFixed(0)}/${d.workloadMs.median.toFixed(0)}/${d.workloadMs.max.toFixed(0)}ms  stop ${d.stopMs.min.toFixed(0)}/${d.stopMs.median.toFixed(0)}/${d.stopMs.max.toFixed(0)}ms  rss ${d.peakRSSKB.min}/${d.peakRSSKB.median}/${d.peakRSSKB.max}KB  events ${d.events.median}`);
  }
  fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2));
  console.log(`\nEvidence: ${outDir}`);
})().catch(e => { console.error(e); server.close(); process.exit(1); });
