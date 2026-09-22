// P4-F5 release performance acceptance (review B6, handoff §10.8-G).
//
// Three states from matched builds (upstream print tracing OFF in both):
//   A = out/XTrace-release-A      observer NOT compiled
//   B = out/XTrace-release        observer compiled, not requested
//   C = out/XTrace-release        observer compiled AND requested
// All runs share tier/causality flags (--js-flags=--max-opt=0,
// --xtrace-causality=sync) so the only deltas are the observer's
// compile-time cost (A vs B) and its runtime gate+event cost (B vs C).
//
// Every run: unique directory, hardened v3 validator FIRST (schema,
// single capture, real line counts), then metrics. Repeats report a
// distribution, never a single value. Evidence binds source/patch/binary/
// driver SHAs + exit codes.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { once } = require('node:events');

const root = path.resolve(__dirname, '..');
const validation = path.resolve(root, 'chromium/src/out/XTraceIntegration/validation');
const outDir = fs.mkdtempSync(path.join(validation, 'p4-f5-perf-'));
const validatorPy = path.join(root, 'scripts', 'validate_trace.py');
const REPEATS = Number(process.env.F5_REPEATS || 5);
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('XTRACE_')));

const binaries = {
  A: path.resolve(root, 'chromium/src/out/XTrace-release-A/ChromiumX.app/Contents/MacOS/Chromium'),
  B: path.resolve(root, 'chromium/src/out/XTrace-release/ChromiumX.app/Contents/MacOS/Chromium'),
};

// Deterministic workload: fixed script, fixed iteration counts, no
// network beyond the local fixture server, completion marker at the end.
const page = '<!doctype html><body><script>' +
  'function calc(n){let s=0;for(let i=0;i<n;i++)s+=(i%7);return s}' +
  'let acc=0;for(let r=0;r<30;r++){acc+=calc(4000);JSON.stringify({reviewMarker:r,acc});}' +
  'window.reviewAnswer=acc;window.reviewDone=true;</script>';
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' });
  res.end(page);
});

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
  }
  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.id; const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(method + ' timeout')); }, 60000);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdio[3].write(JSON.stringify({ id, method, params }) + '\0');
    });
  }
}

function sha256(file) {
  return 'sha256:' + createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function median(xs) { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; }
function stats(xs) {
  const s = [...xs].sort((a, b) => a - b);
  return { min: s[0], median: median(xs), max: s[s.length - 1], all: xs };
}

function sampleRSS(pid) {
  try {
    const out = spawnSync('/bin/ps', ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf8' });
    return Number((out.stdout || '').trim().split('\n')[0]) || 0;
  } catch { return 0; }
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
  const child = spawn(exe, argv, { env, stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });
  const exit = once(child, 'exit'), pipe = new Pipe(child);
  let peakRSS = 0; const sampler = setInterval(() => { peakRSS = Math.max(peakRSS, sampleRSS(child.pid)); }, 100);
  const t0 = process.hrtime.bigint();
  const run = { state, repeat, exe: sha256(exe), exitCode: null };
  try {
    await pipe.send('Browser.getVersion');           // startup barrier
    const t1 = process.hrtime.bigint();
    const { targetId } = await pipe.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await pipe.send('Target.attachToTarget', { targetId, flatten: true });
    await pipe.send('Page.enable', {}, sessionId);
    const w0 = process.hrtime.bigint();
    await pipe.send('Page.navigate', { url: `http://127.0.0.1:${server.address().port}/workload` }, sessionId);
    for (let i = 0; i < 200; i++) {
      const done = await pipe.send('Runtime.evaluate', { expression: 'window.reviewDone === true', returnByValue: true }, sessionId);
      if (done.result.value) break;
      await new Promise(r => setTimeout(r, 25));
    }
    const w1 = process.hrtime.bigint();
    const stop0 = process.hrtime.bigint();
    const stop = await pipe.send('XTrace.stopCapture');
    const stop1 = process.hrtime.bigint();
    run.workloadMs = Number(w1 - w0) / 1e6;
    run.stopMs = Number(stop1 - stop0) / 1e6;
    run.terminal = stop.state;
    run.startupMs = Number(t1 - t0) / 1e6;
    await pipe.send('Browser.close');
  } finally {
    clearInterval(sampler);
    run.exitCode = await exit.then(([code]) => code).catch(() => null);
    fs.writeFileSync(path.join(dir, 'run.json'), JSON.stringify(run, null, 2));
  }
  run.peakRSSKB = peakRSS;
  assert.strictEqual(run.exitCode, 0, `${state}-${repeat}: browser exited ${run.exitCode}`);
  assert.strictEqual(run.terminal, 'complete', `${state}-${repeat}: terminal ${run.terminal}`);

  // Validator FIRST: the hardened v3 contract (schema, single capture,
  // per-producer written == observed records) gates every measurement.
  const v = spawnSync('python3', [validatorPy, '--schema-version', '3', '--expect', 'JSON.stringify', trace],
      { encoding: 'utf8', timeout: 120000 });
  run.validatorExit = v.status;
  if (v.status !== 0) {
    fs.writeFileSync(path.join(dir, 'validator.txt'), (v.stdout || '') + (v.stderr || ''));
    throw new Error(`${state}-${repeat}: validator failed: ${(v.stderr || v.stdout || '').slice(0, 400)}`);
  }
  const text = fs.readFileSync(trace, 'utf8');
  run.events = text.trim() ? text.trim().split('\n').length : 0;
  run.ignition = (text.match(/"api":"Ignition.execute"/g) || []).length;
  run.traceBytes = Buffer.byteLength(text);
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'trace.manifest.json'), 'utf8'));
  run.dropped = manifest.counts?.dropped ?? '?';
  run.failed = manifest.counts?.failed ?? '?';
  run.written = manifest.counts?.written ?? '?';
  if (state === 'C') assert(run.ignition > 0, `${state}-${repeat}: observer-on run with zero ignition events`);
  if (state !== 'C') assert(run.ignition === 0, `${state}-${repeat}: unexpected ignition events without observer request`);
  fs.writeFileSync(path.join(dir, 'run.json'), JSON.stringify(run, null, 2));
  return run;
}

(async () => {
  for (const [state, exe] of Object.entries(binaries)) {
    if (!fs.existsSync(exe)) { console.error(`binary missing: ${exe}`); process.exit(2); }
  }
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const results = { A: [], B: [], C: [] };
  try {
    for (let i = 1; i <= REPEATS; i++) {
      for (const state of ['A', 'B', 'C']) {
        const run = await oneRun(state, i);
        results[state].push(run);
        console.log(`${state}-${i}: workload=${run.workloadMs.toFixed(0)}ms stop=${run.stopMs.toFixed(0)}ms events=${run.events} ignition=${run.ignition} rss=${run.peakRSSKB}KB`);
      }
    }
  } finally { server.close(); }

  const summary = {
    ts: new Date().toISOString(),
    repeats: REPEATS,
    binaries: { A: sha256(binaries.A), B: sha256(binaries.B) },
    frameworks: {
      A: sha256(path.resolve(binaries.A, '../../Frameworks/Chromium Framework.framework/Chromium Framework')),
      B: sha256(path.resolve(binaries.B, '../../Frameworks/Chromium Framework.framework/Chromium Framework')),
    },
    sourceHead: spawnSync('git', ['-C', path.join(root, 'chromium/src'), 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim(),
    patches: fs.readdirSync(path.join(root, 'patches')).filter(f => f.endsWith('.patch')).sort()
        .map(f => ({ f, sha256: sha256(path.join(root, 'patches', f)) })),
    driver: sha256(__filename),
    argsGn: { A: fs.readFileSync(path.resolve(root, 'chromium/src/out/XTrace-release-A/args.gn'), 'utf8'),
               B: fs.readFileSync(path.resolve(root, 'chromium/src/out/XTrace-release/args.gn'), 'utf8') },
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
      droppedAllZero: rs.every(r => Number(r.dropped) === 0),
      failedAllZero: rs.every(r => Number(r.failed) === 0),
    };
  }
  const d = summary.distributions;
  console.log('\n== Distributions (min/median/max over ' + REPEATS + ') ==');
  for (const state of ['A', 'B', 'C']) {
    const w = d[state].workloadMs, s = d[state].stopMs, r = d[state].peakRSSKB;
    console.log(`${state}: workload ${w.min.toFixed(0)}/${w.median.toFixed(0)}/${w.max.toFixed(0)}ms  stop ${s.min.toFixed(0)}/${s.median.toFixed(0)}/${s.max.toFixed(0)}ms  rss ${r.min}/${r.median}/${r.max}KB  events ${d[state].events.median}`);
  }
  fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2));
  console.log(`\nEvidence: ${outDir}`);
})().catch(e => { console.error(e); server.close(); process.exit(1); });
