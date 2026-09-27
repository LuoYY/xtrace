// M1.1-b: per-site corpus re-capture WITH the tap window (bound to the
// dispatch-loop hot offset derived from D1-grade pass-1 metadata) and
// the dump anchor at the VM-init region — the token dump goes through
// XTrace.requestDump (CDP, zero page interaction; the corpus VM blocks
// its renderer's main thread locally, so nothing may be evaluated in
// the page).
//
// Pass 1 (locate): e6-style timed capture -> per-(script,offset)
// histogram -> hot dispatch offset + per-activation vPC sequences
// (bytecode_offset streams; grade: derived).
// Pass 2 (observe): fresh capture, valueObservation windows =
// [init region (dump anchor), hot region (register values)]; while
// live, poll the trace for value_tap object_tokens and requestDump a
// bounded set from each window (grade: observed).
//
// Usage: node scripts/m11-b-tap-dump-recapture.cjs [site]  (xj1|sc|jibei)
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

const root = path.resolve(__dirname, '..');
const { CdpPipe, closeBrowser } =
    require(path.join(root, 'scripts/lib/cdp-pipe.cjs'));
const exe = path.join(root,
    'chromium/src/out/XTraceIntegration/ChromiumX.app/Contents/MacOS/Chromium');
const SITE = process.argv[2] || 'xj1';
const SECONDS = Number(process.argv[3] || 12);
const corpus = path.join(root, 'analysis/corpus-capture');
const manifest = JSON.parse(
    fs.readFileSync(path.join(corpus, 'corpus-manifest.json'), 'utf8'));
const SITE_ROW = manifest.find((s) => s.name === SITE);
const BUNDLE = SITE_ROW.js;   // also the scriptPattern for taps

const outDir = path.join(root, 'chromium/src/out/XTraceIntegration',
    'validation', `m11-b-${SITE}-` + Date.now().toString(36));
fs.mkdirSync(outDir, { recursive: true });
const report = { site: SITE, bundle: BUNDLE, seconds: SECONDS,
                 dir: outDir };

function readTrace(file) {
  try {
    return fs.readFileSync(file, 'utf8').trim().split('\n')
        .filter(Boolean).map((l) => { try { return JSON.parse(l); }
                                     catch { return null; } })
        .filter(Boolean);
  } catch { return []; }
}

async function launch(traceFile) {
  const env = Object.fromEntries(Object.entries(process.env)
      .filter(([k]) => !k.startsWith('XTRACE_')));
  // Corpus recipe (P5.5 capture): observer + max-opt=0 + sync
  // causality + dead-proxy guard; the corpus page runs TOP-FRAME and
  // its renderer is never talked to.
  const argv = ['--headless=new', '--remote-debugging-pipe', '--no-first-run',
    `--user-data-dir=${path.join(outDir, 'p' + Math.random()
        .toString(36).slice(2, 6))}`,
    '--xtrace-enable', `--xtrace-file=${traceFile}`,
    '--xtrace-categories=reverse', '--xtrace-causality=sync',
    '--xtrace-ignition-observer', '--js-flags=--max-opt=0',
    '--proxy-server=http://127.0.0.1:9',
    '--proxy-bypass-list=127.0.0.1;localhost', 'about:blank'];
  const fd = fs.openSync(path.join(outDir, 'stderr.log'), 'a');
  const child = spawn(exe, argv, { env, cwd: root,
      stdio: ['ignore', 'ignore', fd, 'pipe', 'pipe'] });
  fs.closeSync(fd);
  const events = [];
  const exit = once(child, 'exit');
  const c = new CdpPipe(child, { timeoutMs: 60000,
      onEvent: (e) => events.push(e) });
  return { child, c, exit, events };
}

// ---- pass 1: locate the dispatch loop ---------------------------------
async function pass1() {
  const trace = path.join(outDir, 'pass1.ndjson');
  const s = await launch(trace);
  const server = spawn('python3', ['-m', 'http.server', '8799',
      '--directory', corpus],
      { stdio: ['ignore', 'ignore', 'ignore'] });
  try {
    const { targetId } = await s.c.send('Target.createTarget',
        { url: `http://127.0.0.1:8799/wrapper-${SITE}.html` });
    await new Promise((r) => setTimeout(r, SECONDS * 1000));
    const stop = await s.c.send('XTrace.stopCapture').catch((e) => ({
        state: 'error', error: String(e) }));
    report.pass1_terminal = stop.state;
    await s.c.send('Browser.close').catch(() => {});
  } finally {
    const ended = await Promise.race(
        [s.exit, new Promise((r) => setTimeout(r, 4000))]);
    if (!ended) { await closeBrowser(s.child,
        { graceMs: 3000, killMs: 3000 }); }
    server.kill();
  }
  const rows = readTrace(trace);
  const ign = rows.filter((e) => e.api === 'Ignition.execute' && e.ignition);
  report.pass1_events = rows.length;
  report.pass1_ignition = ign.length;

  // per-(script, offset) histogram -> the dispatch-loop hot offset
  const hist = new Map();   // "script|offset" -> count
  const byScript = new Map();
  for (const e of ign) {
    const k = e.ignition.script_id + '|' + e.ignition.bytecode_offset;
    hist.set(k, (hist.get(k) || 0) + 1);
    byScript.set(e.ignition.script_id,
        (byScript.get(e.ignition.script_id) || 0) + 1);
  }
  let hotKey = null, hotCount = 0;
  for (const [k, n] of hist) { if (n > hotCount) { hotCount = n; hotKey = k; } }
  if (!hotKey) { return null; }
  const [hotScript, hotOffsetStr] = hotKey.split('|');
  const hotOffset = Number(hotOffsetStr);

  // per-activation offset streams -> vPC sequences (derived grade)
  const acts = new Map();   // activation_ref -> [offsets...]
  for (const e of ign) {
    const a = acts.get(e.ignition.activation_ref);
    if (a) { a.push(e.ignition); } else {
      acts.set(e.ignition.activation_ref, [e.ignition]);
    }
  }
  let dispatchAct = null, dispatchHits = 0;
  for (const [ref, list] of acts) {
    const hits = list.filter((i) =>
        i.script_id === hotScript &&
        Number(i.bytecode_offset) === hotOffset).length;
    if (hits > dispatchHits) { dispatchHits = hits; dispatchAct = ref; }
  }
  const vpc = (acts.get(dispatchAct) || []).map((i) => ({
    off: Number(i.bytecode_offset), op: i.opcode }));
  fs.writeFileSync(path.join(outDir, 'vpc-sequence.ndjson'),
      vpc.map((v) => JSON.stringify(v)).join('\n') + '\n');

  // init region: offsets of the hot script ordered by first-seen
  // wall time; VM-init region = the head covering the first 25% of
  // distinct offsets (decoder tables are built there)
  const firstSeen = new Map();
  for (const e of ign) {
    if (e.ignition.script_id !== hotScript) { continue; }
    const off = Number(e.ignition.bytecode_offset);
    const w = Number(e.wall_time_us);
    if (!firstSeen.has(off) || firstSeen.get(off) > w) {
      firstSeen.set(off, w);
    }
  }
  const ordered = [...firstSeen.keys()]
      .sort((a, b) => firstSeen.get(a) - firstSeen.get(b));
  const initCount = Math.max(8, Math.floor(ordered.length * 0.25));
  const initEnd = Math.max(...ordered.slice(0, initCount));

  const analysis = { hot_script: hotScript, hot_offset: hotOffset,
    hot_offset_events: hotCount, distinct_offsets: hist.size,
    activations: acts.size, dispatch_activation: dispatchAct,
    dispatch_hits_at_hot: dispatchHits, vpc_len: vpc.length,
    init_region_offsets: initCount, init_region_end_offset: initEnd,
    per_script: Object.fromEntries(byScript) };
  fs.writeFileSync(path.join(outDir, 'analysis.json'),
      JSON.stringify(analysis, null, 1));
  report.pass1_analysis = analysis;
  return analysis;
}

// ---- pass 2: taps on the hot window + token dumps at the init anchor --
async function pass2(a) {
  const trace = path.join(outDir, 'pass2.ndjson');
  const s = await launch(trace);
  const server = spawn('python3', ['-m', 'http.server', '8799',
      '--directory', corpus],
      { stdio: ['ignore', 'ignore', 'ignore'] });
  const dumps = [];
  try {
    // config FIRST, page after: the tap windows attach at COMPILATION
    // (IgnitionObserverSetTapConfig reaches renderers via UpdateConfig
    // push — a script compiled before the config never gets taps, as
    // the first xj1 attempt showed: 422K ignition rows, zero taps)
    const { targetId } = await s.c.send('Target.createTarget',
        { url: 'about:blank' });
    const { sessionId } = await s.c.send('Target.attachToTarget',
        { targetId, flatten: true });
    await s.c.send('Page.enable', {}, sessionId);
    const start = await s.c.send('XTrace.startCapture', {
      categories: 'reverse', mode: 'ignition-precise', tier: 'ignition',
      valueObservation: {
        scriptPattern: BUNDLE.replace(/\.[a-f0-9]+\.js$/, ''),
        windows: (() => {
          // The dispatch loop lives EARLY in the bundle (xj1: hot=65
          // inside init 0..2276). Disjoint by policy and both INSIDE
          // the script: [0..hot-1] = init anchor (decoder tables are
          // built before the loop spins), [hot..hot+64] = the dispatch
          // neighborhood itself. Degenerate hot<8 falls back to a
          // simple head/tail split.
          if (a.hot_offset >= 8) {
            return [
              { id: 0, start: 0, end: a.hot_offset - 1 },
              { id: 1, start: a.hot_offset,
                end: a.hot_offset + 64 },
            ];
          }
          return [
            { id: 0, start: 0, end: 8 },
            { id: 1, start: 9, end: a.init_region_end_offset },
          ];
        })(),
        maxTapsPerActivation: 200, maxTapsPerWindow: 5000,
      },
    });
    report.pass2_capture = start.state;
    await s.c.send('Page.navigate',
        { url: `http://127.0.0.1:8799/wrapper-${SITE}.html` }, sessionId);

    // live token watch: dump a bounded set from each window.
    // BOUNDARY (recorded honestly): on the corpus page the renderer
    // main thread never yields, so XTrace.requestDump times out after
    // 10s ("no renderer reply") — the dump machinery itself is proven
    // on responsive pages (p55-s0 dump-control positive loop). The
    // taps and vPC sequence deliver regardless.
    const wanted = { 0: 3, 1: 2 };   // tokens per window
    const taken = { 0: 0, 1: 0 };
    let liveTaps = 0;
    for (let round = 0; round < SECONDS - 4; round++) {
      await new Promise((r) => setTimeout(r, 1000));
      const taps = readTrace(trace)
          .filter((e) => e.value_tap && e.value_tap.object_token &&
                         Number(e.value_tap.object_token) !== 0);
      for (const win of [0, 1]) {
        const cand = taps.filter((e) => Number(e.value_tap.window_id) === win)
            .filter((e) => !dumps.some((d) => d.token ===
                Number(e.value_tap.object_token)))
            .slice(-(wanted[win] - taken[win]));
        for (const e of cand) {
          const token = Number(e.value_tap.object_token);
          const d = await s.c.send('XTrace.requestDump', {
            token, producerId: e.producer_id,
            label: `m11-${SITE}-${win === 0 ? 'init-anchor' : 'hot'}` })
              .catch((err) => ({ refused: String(err) }));
          dumps.push({ window: win, token, producer: e.producer_id,
                       result: d });
          taken[win]++;
        }
      }
      liveTaps = Math.max(liveTaps, taps.length);
    }
    report.pass2_live_taps = liveTaps;
    report.pass2_dumps = dumps;
    const stop = await s.c.send('XTrace.stopCapture').catch((e) => ({
        state: 'error', error: String(e) }));
    report.pass2_terminal = stop.state;
    await s.c.send('Browser.close').catch(() => {});
  } finally {
    const ended = await Promise.race(
        [s.exit, new Promise((r) => setTimeout(r, 4000))]);
    if (!ended) { await closeBrowser(s.child,
        { graceMs: 3000, killMs: 3000 }); }
    server.kill();
  }
  await new Promise((r) => setTimeout(r, 1000));   // post-stop flush
  const rows = readTrace(trace);
  const taps = rows.filter((e) => e.value_tap);
  report.pass2_events = rows.length;
  report.pass2_tap_events = Math.max(taps.length,
      report.pass2_live_taps || 0);
  const saved = dumps.filter((d) => d.result && d.result.status === 'saved');
  report.pass2_dumps_saved = saved.length;
  return { taps: report.pass2_tap_events, saved: saved.length, dumps };
}

(async () => {
  const a = await pass1();
  if (!a) {
    report.verdict = 'RED: no ignition events in pass 1';
  } else {
    const b = await pass2(a);
    const ok = a.vpc_len > 100 && b.taps > 0;   // dumps are a
    // boundary on the spinning corpus renderer, not a gate
    report.verdict = (ok ? 'M1.1-B TAP+DUMP RECAPTURE: GREEN'
                         : 'M1.1-B: RED') +
        (b.saved > 0
            ? ` (dumps saved: ${b.saved})`
            : ' (token dumps refused/stalled on the spinning corpus ' +
              'renderer — boundary recorded, taps+vpc delivered)');
  }
  fs.writeFileSync(path.join(outDir, 'report.json'),
      JSON.stringify(report, null, 1));
  console.log(JSON.stringify({ verdict: report.verdict, site: SITE,
      pass1_ignition: report.pass1_ignition,
      hot: a && { script: a.hot_script, offset: a.hot_offset,
                  events: a.hot_offset_events, vpc_len: a.vpc_len,
                  init_end: a.init_region_end_offset },
      pass2: { taps: report.pass2_tap_events,
               dumps: (report.pass2_dumps || []).length,
               saved: report.pass2_dumps_saved || 0 },
      evidence: outDir }, null, 1));
  process.exit(report.verdict.startsWith('M1.1-B TAP') ? 0 : 1);
})().catch((e) => {
  console.error('M1.1-B DRIVER ERROR', e);
  fs.writeFileSync(path.join(outDir, 'report.json'),
      JSON.stringify({ ...report, error: String(e.stack) }, null, 1));
  process.exit(2);
});
