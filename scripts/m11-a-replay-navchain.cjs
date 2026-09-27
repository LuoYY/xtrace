// M1.1-a: drive the local 412->200 replay over the REAL corpus
// first stage (xj1 wrapper + bundle) and anchor the two-stage flow at
// three levels (the echo-oracle discipline):
//   L1 observed  — the replay server's own request log (outside the
//                  engine): 412 with no new cookie, then 200 whose
//                  Cookie header carries the anchor VALUE.
//   L2 observed  — engine events: the stage-1 Document.cookie.set
//                  carrying the same value + manifest.identity
//                  nav_chain succession (from/to documents, cause,
//                  shared nav_chain_id).
//   L3 derived   — value equality L1==L2 + ordering (set precedes the
//                  200 request) + chain identity. Never causal closure.
// Two arms, honestly graded:
//   R — the corpus VM itself sets a fresh cookie in the local context
//       (full anchor claim);
//   S — pre-authorized degradation (roadmap M1.1 row): after the
//       corpus-settled wait no VM cookie appeared (P5.5 boundary: the
//       local context has no server challenge material), so the driver
//       plants the anchor and reloads — proving the 412->200 +
//       nav_chain + three-level machinery on the real first stage;
//       "first stage computes the cookie" is recorded NOT DEMONSTRATED
//       locally, consistent with the P5.5 corpus boundary.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

const root = path.resolve(__dirname, '..');
const { CdpPipe, closeBrowser } =
    require(path.join(root, 'scripts/lib/cdp-pipe.cjs'));
const exe = path.join(root,
    'chromium/src/out/XTraceIntegration/ChromiumX.app/Contents/MacOS/Chromium');

const SITE = process.env.M11_SITE || 'xj1';
const runDir = fs.mkdtempSync(path.join(root,
    'chromium/src/out/XTraceIntegration/validation', 'm11-a-'));
const trace = path.join(runDir, 'trace.ndjson');
const echoLog = path.join(runDir, 'echo.ndjson');

const server = spawn('python3', ['-u',
    path.join(root, 'scripts/m11_replay_server.py'),
  '--corpus-dir', path.join(root, 'analysis/corpus-capture'),
   '--site', SITE, '--echo-log', echoLog],
  { stdio: ['ignore', 'pipe', 'ignore'] });

const report = { site: SITE, run_dir: runDir };

(async () => {
  const port = await new Promise((r) => {
    let t = '';
    server.stdout.on('data', (c) => {
      t += c;
      const m = t.match(/"port":\s*(\d+)/);
      if (m) { r(Number(m[1])); }
    });
  });

  const env = Object.fromEntries(Object.entries(process.env)
      .filter(([k]) => !k.startsWith('XTRACE_')));
  // Corpus environment (P5.5 capture shape) + dead-proxy guard: any
  // off-localhost egress fails instantly; the corpus is local-only.
  const argv = ['--headless=new', '--remote-debugging-pipe', '--no-first-run',
    `--user-data-dir=${path.join(runDir, 'p')}`,
    '--xtrace-enable', `--xtrace-file=${trace}`,
    '--xtrace-categories=reverse', '--xtrace-causality=off',
    '--xtrace-ignition-observer', '--js-flags=--max-opt=0',
    '--proxy-server=http://127.0.0.1:9',
    '--proxy-bypass-list=127.0.0.1', 'about:blank'];
  const fd = fs.openSync(path.join(runDir, 'stderr.log'), 'w');
  const child = spawn(exe, argv, { env, cwd: root,
      stdio: ['ignore', 'ignore', fd, 'pipe', 'pipe'] });
  fs.closeSync(fd);
  const cdpEvents = [];
  const exit = once(child, 'exit');
  const c = new CdpPipe(child, { timeoutMs: 30000,
      onEvent: (e) => cdpEvents.push(e) });
  try {
    const { targetId } = await c.send('Target.createTarget',
        { url: `http://127.0.0.1:${port}/` });
    const { sessionId } = await c.send('Target.attachToTarget',
        { targetId, flatten: true });
    await c.send('Page.enable', {}, sessionId);
    await c.send('Runtime.enable', {}, sessionId);

    // ---- stage 1: the 412 wrapper runs the corpus VM ----------------
    const readCookie = () => c.send('Runtime.evaluate',
        { expression: 'document.cookie', returnByValue: true }, sessionId)
        .then((r) => r.result.value || '');
    await new Promise((r) => setTimeout(r, 1500));
    const baseline = await readCookie();
    report.stage1_baseline_cookie = baseline;

    // arm R probe: does the VM set a fresh cookie locally? (17K
    // events/s corpus calibration; 10s is ~4x the corpus settle)
    let vmCookie = null;
    for (let i = 0; i < 20 && !vmCookie; i++) {
      await new Promise((r) => setTimeout(r, 500));
      const now = await readCookie();
      const base = new Set(baseline.split(';').map((s) =>
          s.split('=')[0].trim()).filter(Boolean));
      const fresh = now.split(';').map((s) => s.trim())
          .filter((p) => p && !base.has(p.split('=')[0]));
      if (fresh.length) { vmCookie = fresh[0]; }
    }
    let anchor;
    if (vmCookie) {
      report.arm = 'R: corpus VM set a fresh cookie in the local context';
      anchor = vmCookie.split('=').slice(1).join('=');
      report.anchor_cookie_name = vmCookie.split('=')[0];
    } else {
      report.arm = 'S: pre-authorized synthetic anchor (corpus boundary: ' +
          'no server challenge material locally — P5.5 README)';
      anchor = 'm11-' + Math.random().toString(36).slice(2, 12);
      await c.send('Runtime.evaluate',
          { expression: `document.cookie='xtrace_m11=${anchor}; path=/'`,
            returnByValue: true }, sessionId);
      report.anchor_cookie_name = 'xtrace_m11';
    }
    report.anchor_value_head = anchor.slice(0, 24);

    // ---- same-URL reload: the server must see the new cookie → 200 --
    await c.send('Runtime.evaluate',
        { expression: 'location.reload()', returnByValue: true }, sessionId);
    await new Promise((r) => setTimeout(r, 6000));
    const page = await c.send('Runtime.evaluate', { expression:
        "document.getElementById('result') ? " +
        "document.getElementById('result').textContent : ''",
      returnByValue: true }, sessionId);
    report.stage2_page = JSON.parse(page.result.value || 'null');
    const stop = await c.send('XTrace.stopCapture');
    report.terminal = stop.state;
    await c.send('Browser.close');
  } catch (e) {
    report.error = String(e.stack);
  }
  const ended = await Promise.race(
      [exit, new Promise((r) => setTimeout(r, 4000))]);
  if (!ended) { await closeBrowser(child, { graceMs: 3000, killMs: 3000 }); }
  server.kill();

  // ---- L1: server truth (outside the engine) -------------------------
  const echo = fs.readFileSync(echoLog, 'utf8').trim().split('\n')
      .map((l) => JSON.parse(l));
  report.echo_rows = echo.length;
  const first412 = echo.find((r) => r.status === 412 && r.path === '/');
  const ok200 = echo.find((r) => r.status === 200 && r.path === '/' &&
      (r.cookies_new_vs_baseline || []).length > 0);
  report.l1 = { saw_412: !!first412, saw_200_with_new_cookie: !!ok200 };

  // ---- L2/L3: engine events + derivation -----------------------------
  const lines = fs.readFileSync(trace, 'utf8').trim().split('\n')
      .map((l) => JSON.parse(l));
  const manifest = JSON.parse(fs.readFileSync(
      path.join(runDir, 'trace.manifest.json'), 'utf8'));
  const chains = (manifest.identity || {}).nav_chain || [];
  report.nav_chain_rows = chains.length;
  const cookieSet = lines.filter((e) => e.api === 'Document.cookie.set');
  let setEvent = null;
  for (const e of cookieSet) {
    const m = JSON.stringify(e.args || [])
        .match(new RegExp(report.anchor_cookie_name + '=([^"\\\\&;\\s]+)'));
    if (m) { setEvent = { event: e, value: m[1] }; break; }
  }
  report.l2 = { cookie_set_event: !!setEvent,
                nav_chain_rows: chains.length };
  report.l3 = {
    value_equal_l1_l2: !!(ok200 && setEvent &&
        ok200.cookie_header.includes(setEvent.value)),
    ordering_set_before_200: !!(setEvent && ok200 &&
        Number(setEvent.event.wall_time_us / 1000) <
        ok200.ts * 1000 - 0),
  };

  const pass = !report.error &&
      report.stage2_page && report.stage2_page.stage === 2 &&
      report.stage2_page.cookieSeen === true &&
      first412 && ok200 && setEvent && chains.length >= 1 &&
      report.l3.value_equal_l1_l2 && report.l3.ordering_set_before_200;

  fs.writeFileSync(path.join(runDir, 'report.json'),
      JSON.stringify(report, null, 2));
  console.log(JSON.stringify({
    verdict: pass ? 'M1.1-A REPLAY NAVCHAIN: GREEN' : 'M1.1-A: RED',
    arm: report.arm, site: SITE, l1: report.l1, l2: report.l2,
    l3: report.l3, stage2: report.stage2_page,
    evidence: runDir }, null, 1));
  process.exit(pass ? 0 : 1);
})().catch((e) => {
  console.error('M1.1-A DRIVER ERROR', e);
  fs.writeFileSync(path.join(runDir, 'report.json'),
      JSON.stringify({ ...report, error: String(e.stack) }, null, 2));
  server.kill();
  process.exit(2);
});
