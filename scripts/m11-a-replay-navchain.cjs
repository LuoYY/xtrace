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

// ONE server, TWO origins on the same port: the corpus origin is the
// `localhost` HOST, the driver/stage-2 origin is the 127.0.0.1 IP —
// cross-site, so the spinning corpus VM (iframe) is an OOPIF in its
// own process and the top frame stays responsive for the stage-2
// commit. (127.0.0.2 is NOT bindable in this sandbox — Errno 49;
// same-origin isolation cannot split a top frame from its own iframe —
// the commit queues behind the VM's tight loop. Both tried.)
const server = spawn('python3', ['-u',
    path.join(root, 'scripts/m11_replay_server.py'),
  '--corpus-dir', path.join(root, 'analysis/corpus-capture'),
   '--site', SITE, '--echo-log', echoLog],
  { stdio: ['ignore', 'pipe', 'ignore'] });

const report = { site: SITE, run_dir: runDir };

const waitPort = (proc) => new Promise((res, rej) => {
  let t = '';
  const settle = (fn, arg) => { proc.stdout.removeAllListeners(); fn(arg); };
  proc.stdout.on('data', (c) => {
    t += c;
    const m = t.match(/"port":\s*(\d+)/);
    if (m) { settle(res, Number(m[1])); }
  });
  proc.once('exit', (code) => settle(rej,
      new Error('replay server exited early, code=' + code)));
});

(async () => {
  const port = await waitPort(server);
  const ORIGIN = `http://127.0.0.1:${port}`;
  const CORPUS_ORIGIN = `http://localhost:${port}`;
  // tell the server where the stage-1 driver's iframe points (the
  // corpus origin), before the page loads
  await fetch(ORIGIN + '/set-iframe?src=' +
      encodeURIComponent(CORPUS_ORIGIN + '/'))
      .then((r) => r.json()).then((j) => { report.iframe_set = j; })
      .catch((e) => { report.iframe_set_err = String(e); });

  const env = Object.fromEntries(Object.entries(process.env)
      .filter(([k]) => !k.startsWith('XTRACE_')));
  // Corpus environment (P5.5 capture shape) + dead-proxy guard: any
  // off-localhost egress fails instantly; the corpus is local-only.
  const argv = ['--headless=new', '--remote-debugging-pipe', '--no-first-run',
    `--user-data-dir=${path.join(runDir, 'p')}`,
    '--xtrace-enable', `--xtrace-file=${trace}`,
    '--xtrace-categories=reverse', '--xtrace-causality=off',
    '--xtrace-ignition-observer', '--js-flags=--max-opt=0',
    // dead-proxy guard: any off-localhost egress fails instantly; the
    // corpus (localhost) is bypassed along with the loopback IP
    '--proxy-server=http://127.0.0.1:9',
    '--proxy-bypass-list=127.0.0.1;localhost', 'about:blank'];
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
        { url: ORIGIN + '/' });
    const { sessionId } = await c.send('Target.attachToTarget',
        { targetId, flatten: true });
    await c.send('Page.enable', {}, sessionId);
    await c.send('Runtime.enable', {}, sessionId);

    // ---- stage 1: the 412 driver embeds the corpus VM (OOPIF) -------
    // The corpus VM BLOCKS its own renderer's main thread in the local
    // context (no server challenge material — the P5.5 capture used
    // --capture-seconds precisely because it never talks to the page).
    // The A top frame is responsive (the VM is cross-site-isolated);
    // cookie polling and the anchor stay at the BROWSER level anyway.
    const jarCookies = () => c.send('Storage.getCookies')
        .then((r) => r.cookies || []);
    await new Promise((r) => setTimeout(r, 1500));
    const key = (k) => k.domain + '|' + k.name;
    const baseline = new Set((await jarCookies()).map(key));
    report.stage1_baseline_cookies = [...baseline];

    // arm R probe: did the corpus VM set a fresh cookie (on the B
    // origin)? ~17K events/s corpus calibration; 12s covers several
    // corpus settles. If it did, the driver FORWARDS the very same
    // name+value to the A jar (declared synthetic bridge: the real
    // flow is same-origin, so the VM's cookie rides the reload for
    // free; the two-origin replay needs the copy) — the ANCHOR VALUE
    // is VM-computed either way, and the engine-observed set event on
    // B carries it.
    let vmCookie = null;
    for (let i = 0; i < 12 && !vmCookie; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      const fresh = (await jarCookies()).filter((k) => !baseline.has(key(k)));
      if (fresh.length) { vmCookie = fresh[0]; }
    }
    let anchor;
    if (vmCookie) {
      report.arm = 'R: corpus VM computed the anchor (set on the corpus ' +
          'origin, forwarded verbatim to the stage-2 origin — synthetic ' +
          'bridge, declared)';
      anchor = vmCookie.value;
      report.anchor_cookie_name = vmCookie.name;
      await c.send('Storage.setCookies', { cookies: [
          { name: vmCookie.name, value: vmCookie.value,
            url: ORIGIN + '/', path: '/' }] });
    } else {
      report.arm = 'S: pre-authorized synthetic anchor (corpus boundary: ' +
          'no server challenge material locally — P5.5 README)';
      anchor = 'm11-' + Math.random().toString(36).slice(2, 12);
      await c.send('Storage.setCookies', { cookies: [
          { name: 'xtrace_m11', value: anchor, url: ORIGIN + '/',
            path: '/' }] });
      report.anchor_cookie_name = 'xtrace_m11';
    }
    report.anchor_value_head = anchor.slice(0, 24);

    // ---- same-URL navigation: the server must see the new cookie → 200
    // (the top frame is responsive — the corpus iframe spins isolated
    // in its own process — so the stage transition commits cleanly and
    // the succession lands on one nav_chain)
    await c.send('Page.navigate', { url: ORIGIN + '/' }, sessionId);
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
  // arm R carrier: Document.cookie.set (the VM's own set, observed);
  // arm S carrier: Document.cookie.get on the stage-2 page (our page
  // reads the jar once — engine-observed). Both carry the anchor VALUE.
  const wantRe = new RegExp(report.anchor_cookie_name + '=([^"\\\\&;\\s]+)');
  let setEvent = null;
  for (const e of lines.filter((x) => x.api === 'Document.cookie.set')) {
    const m = JSON.stringify(e.args || []).match(wantRe);
    if (m) { setEvent = { api: 'set', value: m[1], wall_us: e.wall_time_us }; break; }
  }
  let getEvent = null;
  for (const e of lines.filter((x) => x.api === 'Document.cookie.get')) {
    const m = JSON.stringify(e.args || []).match(wantRe);
    if (m) { getEvent = { api: 'get', value: m[1], wall_us: e.wall_time_us }; break; }
  }
  const carrier = setEvent || getEvent;
  report.l2 = { carrier: carrier && carrier.api || null,
                nav_chain_rows: chains.length };
  report.l3 = {
    value_equal_l1_l2: !!(ok200 && carrier &&
        ok200.cookie_header.includes(carrier.value)),
    // arm R: engine set precedes the request; arm S: the engine-side
    // read FOLLOWS the request (the jar fact precedes it) — ordering
    // is recorded per arm, never conflated
    ordering: carrier && ok200
        ? (setEvent
            ? Number(setEvent.wall_us) < ok200.ts * 1e6
            : Number(getEvent.wall_us) > ok200.ts * 1e6)
        : false,
  };

  const pass = !report.error &&
      report.stage2_page && report.stage2_page.stage === 2 &&
      report.stage2_page.cookieSeen === true &&
      first412 && ok200 && carrier && chains.length >= 1 &&
      report.l3.value_equal_l1_l2 && report.l3.ordering;

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
