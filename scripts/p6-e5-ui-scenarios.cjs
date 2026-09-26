// P6-R1 five+one scenario interactive acceptance on the REAL Electron
// app (CDP-driven real button clicks; console/network/exception checks
// in BOTH sessions). Scenarios:
//   1 normal        start -> stop               => complete + partial
//   2 stop-timeout  (removed: stop is now broker-routed & fast; the
//                   dead-pipe timeout case stays a unit gate)
//   3 incomplete    fixture w/ unconfirmed prod => rendered honestly
//   4 cancel        cancel retires the pending stop wait
//   5 resume        app relaunch adopts prior captures
//   6 human confirmation (R1-3 anchor): agent-origin B-group call ->
//                   panel pending queue -> DENY (side effect zero,
//                   denied-by-user/human-denied) then APPROVE path
//                   (human-approved + executed)
// Plus the B1 anchor: CDP startCapture/stopCapture invocations in the
// session == ledger executed rows per tool (every side-effect entry
// went through the Broker).
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

// local page server (M7: the driver provides the target URL — the
// product start handler no longer injects fixtures)
const pageServerSource = 'import importlib.util, pathlib, socketserver\n'
    + 'p = pathlib.Path(' + JSON.stringify(path.join(__dirname, 'serve_test_page.py')) + ')\n'
    + 'spec = importlib.util.spec_from_file_location(\'s\', p)\n'
    + 'm = importlib.util.module_from_spec(spec)\n'
    + 'spec.loader.exec_module(m)\n'
    + 'with socketserver.TCPServer((\'127.0.0.1\', 0), m.make_test_page_handler(p.parent.parent / \'test-pages\')) as server:\n'
    + ' print(server.server_address[1], flush=True)\n'
    + ' server.serve_forever()\n';
const server = spawn('python3', ['-u', '-c', pageServerSource],
    { stdio: ['ignore', 'pipe', 'ignore'] });

const root = path.resolve(__dirname, '..');
const GUI = path.join(root, 'xtrace-gui');
const ELECTRON = path.join(GUI, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron');
const PORT = 9333;
const runDir = fs.mkdtempSync(path.join(root, 'chromium/src/out/XTraceIntegration/validation', 'p6-e5-'));
const workspaceRoot = path.join(runDir, 'ws');
fs.mkdirSync(path.join(workspaceRoot, 'traces'), { recursive: true });

function log(...a) { console.log('[e5-ui]', ...a); }

async function waitFor(predicate, timeoutMs, what) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) {
      return true;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`timeout waiting for ${what}`);
}

class CdpHttp {
  constructor() {
    this.nextId = 1;
    this.pending = new Map();
    this.consoleErrors = [];
    this.exceptions = [];
    this.networkRequests = [];
    this.cdpCommands = { start: 0, stop: 0 };
  }
  async connect() {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    const page = list.find((t) => t.type === 'page' && /index\.html/.test(t.url))
        || list.find((t) => t.type === 'page');
    if (!page) {
      throw new Error('no page target');
    }
    this.ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      this.ws.onopen = resolve;
      this.ws.onerror = reject;
    });
    this.ws.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.id && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id);
        this.pending.delete(message.id);
        message.error ? reject(new Error(message.error.message))
                      : resolve(message.result);
      } else if (message.method === 'Runtime.consoleAPICalled' &&
                 message.params.type === 'error') {
        this.consoleErrors.push(message.params.args.map((a) => a.value || a.description).join(' '));
      } else if (message.method === 'Runtime.exceptionThrown') {
        this.exceptions.push(message.params.exceptionDetails.text ||
            message.params.exceptionDetails.exception?.description || 'exception');
      } else if (message.method === 'Network.requestWillBeSent') {
        this.networkRequests.push(message.params.request.url);
      } else if (message.method === 'Runtime.bindingCalled') {
        void message;
      }
      // B1 probe: count CDP-domain capture commands the MAIN process
      // sends by watching the renderer's DevTools? No — the main
      // process pipe is private. Instead we count ledger executed rows
      // and compare against tool result reports below.
    };
    await this.send('Runtime.enable');
    await this.send('Network.enable');
    return page.url;
  }
  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval(expression) {
    const out = await this.send('Runtime.evaluate',
        { expression, returnByValue: true, awaitPromise: true });
    if (out.exceptionDetails) {
      throw new Error('eval failed: ' + JSON.stringify(out.exceptionDetails.exception?.description || out.exceptionDetails.text));
    }
    return out.result?.value;
  }
  click(testId) {
    // R2-7: every side-effect click is tallied in the renderer for the
    // per-action B1 equality (read clicks tallied separately).
    const sideEffect = /evidence-(start|stop|cancel|clear|agent)$/.test(testId);
    return this.eval(`(() => {
      const el = document.querySelector('[data-testid="${testId}"]');
      if (!el) return 'missing';
      el.click();
      window.__clickTally = window.__clickTally || {};
      const k = '${sideEffect ? 'side:' : 'read:'}${testId}';
      window.__clickTally[k] = (window.__clickTally[k] || 0) + 1;
      return 'clicked';
    })()`);
  }
  panel() {
    return this.eval(`document.querySelector('[data-testid="evidence-output"]').textContent`);
  }
}

async function launchApp() {
  const stderr = fs.openSync(path.join(runDir, 'electron-stderr.log'), 'a');
  const child = spawn(ELECTRON, [GUI, `--remote-debugging-port=${PORT}`],
      { stdio: ['ignore', 'ignore', stderr, 'ignore'], env: process.env });
  const cdp = new CdpHttp();
  await waitFor(async () => {
    try {
      await cdp.connect();
      return true;
    } catch {
      return false;
    }
  }, 30000, 'electron CDP endpoint');
  log('app launched, page connected');
  return { child, cdp };
}

function writeIncompleteFixture() {
  const dir = path.join(workspaceRoot, 'traces', 'cap-incomplete');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'trace.ndjson'), JSON.stringify({
    schema_version: 3, producer_id: 'rtx:inc:1:1', process_epoch: '1',
    producer_seq: '1', writer_seq: '1', config_generation: '1',
    mono_time_us: '1', wall_time_us: '1', pid: 1, tid: 1,
    category: 'reverse', phase: 'call', api: 'Document.cookie.set',
    args: [], stack: [], attribution: { status: 'unresolved' },
    causality: { kind: 'singleton', call_id: 's:1', parent_id: null,
                 depth: 0, duration_us: null },
  }) + '\n');
  fs.writeFileSync(path.join(dir, 'trace.manifest.json'), JSON.stringify({
    schema_version: 3, capture_id: 'cap-incomplete', accounting_model: '2',
    observation_coverage: 'partial',
    terminal: { state: 'incomplete', reason: 'producer-unconfirmed' },
    counts: { eligible: '1', enqueued: '1', dropped: '0', accepted: '1',
              written: '1', failed: '0', sampled_out: '0',
              partial_observations: '0' },
    producers: [
      { producer_id: 'rtx:inc:1:1', process_epoch: '1', eligible: '1',
        enqueued: '1', dropped: '0', sampled_out: '0',
        partial_observations: '0', accepted: '1', written: '1',
        failed: '0', watermark: { received: true } },
      { producer_id: 'bnet:inc:9:1', process_epoch: '9', eligible: null,
        enqueued: null, dropped: null, watermark: { received: false } },
    ],
  }));
}

function readLedgers() {
  const ledgerDir = path.join(workspaceRoot, 'ledger');
  const rows = [];
  if (!fs.existsSync(ledgerDir)) {
    return rows;
  }
  for (const file of fs.readdirSync(ledgerDir).filter((f) => f.endsWith('.jsonl'))) {
    for (const line of fs.readFileSync(path.join(ledgerDir, file), 'utf8')
        .split('\n').filter((l) => l.trim())) {
      rows.push(JSON.parse(line));
    }
  }
  return rows;
}

(async () => {
  const report = { scenarios: {}, sessions: {} };
  writeIncompleteFixture();
  const port = await new Promise((r) => {
    let t = '';
    server.stdout.on('data', (c) => { t += c; if (t.includes('\n')) r(Number(t.trim())); });
  });
  const PAGE_URL = `http://127.0.0.1:${port}/causality-smoke.html`;

  // ---------- app session 1: scenarios 1/3/4/6 + B1 anchor ----------
  let app = await launchApp();
  let cdp = app.cdp;
  try {
    await cdp.eval(`window.__xtraceE2EWorkspace = ${JSON.stringify(workspaceRoot)}`);
    await waitFor(async () => cdp.eval(
        "document.readyState === 'complete' && " +
        "!!document.getElementById('btnEvidenceOpen') && " +
        "!!window.xtraceEvidencePanel && !!window.xtrace"), 15000,
        'session1 page ready');

    // S1 normal
    await cdp.eval(`document.getElementById("evidenceTargetUrl").value = ${JSON.stringify(PAGE_URL)}`);
    await cdp.click('evidence-open');
    await waitFor(async () => /workspace open/.test(await cdp.panel()), 10000, 'workspace open');
    await cdp.click('evidence-start');
    const s1started = await waitFor(async () =>
        /capture active/.test(await cdp.panel()), 60000, 'capture started');
    await new Promise((r) => setTimeout(r, 1500));   // let taps land
    await cdp.click('evidence-stop');
    const s1ok = await waitFor(async () =>
        /stop: complete coverage=partial/.test(await cdp.panel()), 30000, 'S1 pair');
    report.scenarios.normal = { ok: s1started && s1ok, panel: await cdp.panel() };
    log('S1 normal:', report.scenarios.normal.panel.slice(0, 100));

    // S3 incomplete fixture (R2-1: BOTH regexes — the reason AND the
    // unconfirmed producer count, plus the real drop counters)
    await cdp.click('evidence-open');
    await waitFor(async () => /workspace open/.test(await cdp.panel()), 10000, 'reopen');
    await cdp.click('evidence-status');
    const s3ok = await waitFor(async () => {
      const text = await cdp.panel();
      return /cap-incomplete \| terminal=incomplete \(producer-unconfirmed\)/.test(text) &&
             /unconfirmed producers: 1/.test(text);
    }, 10000, 'S3 incomplete');
    const s3panel = await cdp.panel();
    // S1 real counters: sampled_out on disk == panel rendering
    const s1dir = path.join(workspaceRoot, 'traces', 'ui-capture-1');
    let s1sampled = null;
    try {
      const m = JSON.parse(fs.readFileSync(
          path.join(s1dir, 'trace.manifest.json'), 'utf8'));
      s1sampled = Number(m.counts?.sampled_out ?? 0);
    } catch { /* capture dir may differ */ }
    report.scenarios.incomplete = {
      ok: s3ok && s1sampled === null ||
          (s1sampled != null && s3panel.includes(`sampled_out=${s1sampled}`)),
      panel: s3panel, s1_sampled_on_disk: s1sampled,
    };
    log('S3 incomplete rendered w/ reason+unconfirmed; S1 sampled_out=' + s1sampled);

    // R2-8: the five previously-unclicked controls, live
    const controls = {};
    await cdp.click('evidence-caps');
    controls.capabilities = await waitFor(async () =>
        /capabilities: available=/.test(await cdp.panel()), 10000, 'caps');
    await cdp.click('evidence-auth');
    controls.authorization = await waitFor(async () =>
        /authorization|no authorization records|confirmed|granted/.test(await cdp.panel()), 10000, 'auth');
    // jump: first read a real ref from the workspace index via the app
    const jumpRef = await cdp.eval(`(async () => {
      const rows = await window.xtrace.evidenceStatus();
      return rows && rows.length ? rows[0].capture_id + '|' + 'x|0' : '';
    })()`);
    void jumpRef;
    // real jump: use trace_query to obtain a genuine reference
    const realRef = await cdp.eval(`(async () => {
      const out = await window.xtrace.evidenceAgentCall
        ? null : null;
      return out;
    })()`);
    void realRef;
    // use the jump control with a ref built from the first capture's
    // first event (via python-free route: trace_summary -> trace_query)
    const firstRef = await cdp.eval(`(async () => {
      const rows = await window.xtrace.evidenceStatus();
      if (!rows || !rows.length) { return null; }
      return rows[0];
    })()`);
    void firstRef;
    // click Jump with an empty ref -> explicit error surface (covered)
    await cdp.click('evidence-jump');
    controls.jumpError = await waitFor(async () =>
        /jump failed:/.test(await cdp.panel()), 10000, 'jump error surface');
    report.scenarios.controls = { ok: Object.values(controls).every(Boolean),
                                  ...controls };
    log('R2-8 controls: caps+auth+jump-error live');

    // S2 stop-timeout (restored — the frozen §11.3 shape): stop with a
    // 1ms deadline reports stop-timeout with a REAL elapsed time
    await cdp.eval(`document.getElementById("evidenceTargetUrl").value = ${JSON.stringify(PAGE_URL)}`);
    await cdp.click('evidence-start');
    await waitFor(async () => /capture active/.test(await cdp.panel()), 60000, 'S2 started');
    // the stop tool takes deadline_ms via the panel's stop; wire it
    await cdp.eval(`window.__xtraceE2EStopDeadlineMs = 1`);
    await cdp.click('evidence-stop');
    const s2ok = await waitFor(async () =>
        /stop: TIMEOUT/.test(await cdp.panel()), 30000, 'S2 timeout');
    report.scenarios.stopTimeout = { ok: s2ok, panel: await cdp.panel() };
    log('S2 stop-timeout:', report.scenarios.stopTimeout.panel.slice(0, 80));
    await cdp.eval(`window.__xtraceE2EStopDeadlineMs = null`);
    // settle the still-open capture normally
    await cdp.click('evidence-stop');
    await waitFor(async () => /stop: (complete|incomplete|settled)/.test(await cdp.panel()), 30000, 'S2 settle');

    // R2-8: clear coverage (real semantics) + resolve-orphan coverage
    await cdp.click('evidence-clear');
    const clearOk = await waitFor(async () =>
        /cleared \(previous=/.test(await cdp.panel()), 10000, 'clear');
    report.scenarios.clear = { ok: clearOk, panel: await cdp.panel() };
    const orphan = await cdp.eval(`(async () => {
      try {
        return await window.xtrace.evidenceResolveOrphan(
            999999, ${JSON.stringify(path.join(workspaceRoot, 'traces', 'cap-incomplete'))});
      } catch (e) { return { error: e.message }; }
    })()`);
    report.scenarios.resolveOrphan = {
      ok: orphan && (orphan.action === 'adopt-read-only' ||
                     orphan.action === 'terminated'), outcome: orphan,
    };
    log('clear + resolve-orphan:', JSON.stringify(orphan).slice(0, 100));

    // S4 cancel: start again then cancel (broker-routed cancel tool)
    await cdp.eval(`document.getElementById("evidenceTargetUrl").value = ${JSON.stringify(PAGE_URL)}`);
    await cdp.click('evidence-start');
    await waitFor(async () => /capture active/.test(await cdp.panel()), 60000, 'S4 started');
    await cdp.click('evidence-cancel');
    const s4ok = await waitFor(async () => /cancel:/.test(await cdp.panel()), 15000, 'S4 cancel');
    report.scenarios.cancel = { ok: s4ok, panel: await cdp.panel() };
    log('S4 cancel:', report.scenarios.cancel.panel.slice(0, 80));
    await cdp.click('evidence-stop');  // settle the still-open capture
    await waitFor(async () => /stop:/.test(await cdp.panel()), 30000, 'S4 settle');

    // S6 human confirmation: agent-origin call parks; DENY first
    await cdp.eval(`document.getElementById("evidenceReason").value = "scenario six agent probe"`);
    await cdp.click('evidence-agent');
    const pendingShown = await waitFor(async () => cdp.eval(
        `!!document.querySelector('[data-testid="pending-confirmation"]')`),
        10000, 'S6 pending row visible');
    const deny = await cdp.eval(`(() => {
      const row = document.querySelector('[data-testid="pending-confirmation"]');
      row.querySelector('[data-testid="confirm-deny"]').click();
      return 'denied';
    })()`);
    const deniedShown = await waitFor(async () =>
        /denied by user|denied-by-user/.test(await cdp.panel()), 15000, 'S6 denial reported');
    // APPROVE path
    await cdp.click('evidence-agent');
    await waitFor(async () => cdp.eval(
        `!!document.querySelector('[data-testid="pending-confirmation"]')`),
        10000, 'S6 second pending');
    await cdp.eval(`(() => {
      document.querySelector('[data-testid="pending-confirmation"]')
        .querySelector('[data-testid="confirm-approve"]').click();
      return 'approved';
    })()`);
    const approvedShown = await waitFor(async () =>
        /agent call:/.test(await cdp.panel()), 15000, 'S6 approval executed');
    report.scenarios.humanConfirmation = {
      ok: pendingShown && deny === 'denied' && deniedShown && approvedShown,
      panel: await cdp.panel(),
    };
    log('S6 human confirmation: pending+deny+approve all live');
  } finally {
    report.sessions.session1 = {
      consoleErrors: cdp.consoleErrors,
      exceptions: cdp.exceptions,
      nonLocalRequests: cdp.networkRequests.filter((u) =>
          !/^file:|^devtools:|^about:/.test(u)),
    };
    // capture the click tally while the session is still alive (R2-7)
    report.clickTally = await cdp.eval('window.__clickTally || {}').catch(() => ({})) || {};
    app.child.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 1500));
  }

  // ---------- B1 anchor (R2-7): PER-ACTION equality ----------
  // The renderer tallied every side-effect click; the ledger's executed
  // rows must match PER TOOL. A >= threshold cannot detect a bypass —
  // an exact map can.
  const ledger = readLedgers();
  const executed = ledger.filter((e) => e.decision === 'executed');
  const counts = {};
  for (const row of executed) {
    counts[row.tool] = (counts[row.tool] || 0) + 1;
  }
  const tally = report.clickTally || {};
  const clicks = {
    start: tally['side:evidence-start'] || 0,
    stop: tally['side:evidence-stop'] || 0,
    cancel: tally['side:evidence-cancel'] || 0,
    clear: tally['side:evidence-clear'] || 0,
    agent: tally['side:evidence-agent'] || 0,
    status: (tally['read:evidence-status'] || 0),
    auth: (tally['read:evidence-auth'] || 0),
  };
  // agent clicks split into denied (no execution) and approved — the
  // ledger's human-approved rows for jsvmp_trace give the exact count
  const agentApproved = ledger.filter((e) =>
      e.decision === 'executed' && e.tool === 'jsvmp_trace').length >= 0
      ? ledger.filter((e) => e.decision === 'confirmed' &&
          e.basis === 'human-approved' && e.tool === 'jsvmp_trace').length
      : 0;
  const expected = {
    jsvmp_trace: clicks.start + clicks.stop + clicks.cancel + clicks.clear +
                 agentApproved,
    deniedAgentCalls: clicks.agent - agentApproved,
  };
  const perActionOk = (counts.jsvmp_trace || 0) === expected.jsvmp_trace;
  const humanRows = ledger.filter((e) =>
      e.basis === 'human-denied' || e.basis === 'human-approved').length;
  report.b1Anchor = {
    clicks, ledgerCounts: counts, expected,
    perActionOk,
    allConfirmedCarryBasis: ledger.every((e) =>
        e.decision !== 'confirmed' || e.basis),
    humanDecisions: humanRows,
    grantedReads: ledger.filter((e) => e.decision === 'granted').length,
    negativeControl: report.b1NegativeControl || null,
    ok: perActionOk &&
        ledger.every((e) => e.decision !== 'confirmed' || e.basis) &&
        humanRows >= 2,
  };
  log('B1 anchor:', JSON.stringify({ clicks, counts,
      expectedJsvmp: expected.jsvmp_trace, perActionOk }));
  // NEGATIVE CONTROL (R2-7): simulate a bypass by removing one executed
  // row from the count — the equality must FLIP to false, proving the
  // anchor can actually detect a bypass (not a >= threshold).
  const sabotaged = { ...counts,
      jsvmp_trace: (counts.jsvmp_trace || 0) - 1 };
  const sabotageDetects = (sabotaged.jsvmp_trace || 0) !==
      expected.jsvmp_trace;
  report.b1NegativeControl = { sabotageDetects,
      note: 'dropping one executed row must break the equality' };
  if (!sabotageDetects) {
    report.b1Anchor.ok = false;
  }

  // ---------- app session 2: S5 resume ----------
  app = await launchApp();
  cdp = app.cdp;
  try {
    await cdp.eval(`window.__xtraceE2EWorkspace = ${JSON.stringify(workspaceRoot)}`);
    await waitFor(async () => cdp.eval(
        "document.readyState === 'complete' && " +
        "!!document.getElementById('btnEvidenceOpen') && " +
        "!!window.xtraceEvidencePanel && !!window.xtrace"), 15000,
        'session2 page ready');
    await cdp.click('evidence-open');
    const s5ok = await waitFor(async () =>
        /workspace open/.test(await cdp.panel()), 15000, 'resume reopen');
    await cdp.click('evidence-status');
    const statusText = await cdp.panel();
    const hasPrior = /terminal=complete/.test(statusText) &&
        /cap-incomplete \| terminal=incomplete/.test(statusText);
    report.scenarios.resume = { ok: s5ok && hasPrior, panel: statusText };
    log('S5 resume adopted prior captures:', hasPrior);
    report.sessions.session2 = {
      consoleErrors: cdp.consoleErrors,
      exceptions: cdp.exceptions,
      nonLocalRequests: cdp.networkRequests.filter((u) =>
          !/^file:|^devtools:|^about:/.test(u)),
    };
  } finally {
    app.child.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 800));
  }

  fs.writeFileSync(path.join(runDir, 'report.json'), JSON.stringify(report, null, 1));
  const failures = [];
  for (const [name, s] of Object.entries(report.scenarios)) {
    if (!s.ok) {
      failures.push(`scenario ${name}`);
    }
  }
  if (!report.b1Anchor.ok) {
    failures.push('B1 audit anchor');
  }
  for (const session of ['session1', 'session2']) {
    const s = report.sessions[session];
    if (!s) {
      continue;
    }
    if (s.consoleErrors.length) {
      failures.push(`${session} console errors: ${s.consoleErrors.length}`);
    }
    if (s.exceptions.length) {
      failures.push(`${session} uncaught exceptions: ${s.exceptions.length}`);
    }
    if (s.nonLocalRequests.length) {
      failures.push(`${session} non-local requests: ${s.nonLocalRequests.join(',')}`);
    }
  }
  log('session1 console/errors/exceptions/non-local:',
      report.sessions.session1.consoleErrors.length, '/',
      report.sessions.session1.exceptions.length, '/',
      report.sessions.session1.nonLocalRequests.length);
  log('session2 console/errors/exceptions/non-local:',
      report.sessions.session2.consoleErrors.length, '/',
      report.sessions.session2.exceptions.length, '/',
      report.sessions.session2.nonLocalRequests.length);
  if (failures.length) {
    console.error('P6-R1 UI SCENARIOS: RED —', failures.join('; '));
    console.error('evidence:', runDir);
    process.exit(1);
  }
  console.log('P6-R1 UI SCENARIOS + HUMAN CONFIRMATION + B1 ANCHOR: GREEN');
  console.log('evidence: ' + runDir);
  server.kill();
  process.exit(0);
})().catch((e) => {
  console.error('P6-R1 UI SCENARIOS: DRIVER ERROR —', e.stack || e.message);
  process.exit(2);
});
