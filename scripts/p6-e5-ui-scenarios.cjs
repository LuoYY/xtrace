// P6-E5 slice 2: the FIVE-SCENARIO interactive acceptance.
//
// Launches the REAL Electron app with --remote-debugging-port, drives
// the evidence panel by CLICKING its buttons through CDP (renderer
// event loop — real interaction, not logic calls), and checks the
// renderer console (zero unexplained errors) and network (zero
// non-local requests). Scenarios:
//   1 normal      start -> taps -> stop        => complete + partial
//   2 stop-timeout 1ms deadline               => TIMEOUT rendered
//   3 incomplete  fixture w/ unconfirmed prod => incomplete rendered
//   4 cancel      stop (long deadline) + Cancel => cancelled rendered
//   5 resume      app relaunch on same workspace => captures adopted
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const GUI = path.join(root, 'xtrace-gui');
const ELECTRON = path.join(GUI, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron');
const PORT = 9333;
const runDir = fs.mkdtempSync(path.join(root, 'chromium/src/out/XTraceIntegration/validation', 'p6-e5-ui-'));
const workspaceRoot = path.join(runDir, 'ws');

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
  constructor(wsUrl) {
    this.nextId = 1;
    this.pending = new Map();
    this.consoleErrors = [];
    this.networkRequests = [];
  }
  async connect() {
    // minimal WS client via global WebSocket (node >= 21)
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    const page = list.find((t) => t.type === 'page' && /index\.html/.test(t.url))
        || list.find((t) => t.type === 'page');
    if (!page) {
      throw new Error('no page target: ' + JSON.stringify(list.map((t) => t.url)));
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
      } else if (message.method === 'Network.requestWillBeSent') {
        this.networkRequests.push(message.params.request.url);
      }
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
    return this.eval(`(() => {
      const el = document.querySelector('[data-testid="${testId}"]');
      if (!el) return 'missing';
      el.click();
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

(async () => {
  const report = { scenarios: {} };
  fs.mkdirSync(workspaceRoot, { recursive: true });

  // ---------- app session 1: scenarios 1-4 --------------------------
  let app = await launchApp();
  let cdp = app.cdp;
  try {
    await cdp.eval(`window.__xtraceE2EWorkspace = ${JSON.stringify(workspaceRoot)}`);
    // clicks must land AFTER app.js attached its handlers (same race as
    // session 2 — hit once under load in the E7 matrix rerun)
    await waitFor(async () => cdp.eval(
        "document.readyState === 'complete' && " +
        "!!document.getElementById('btnEvidenceOpen') && " +
        "!!window.xtraceEvidencePanel && !!window.xtrace"), 15000,
        'session1 page ready');

    // scenario 1: NORMAL — start (tiny budget -> real skips) -> stop
    await cdp.click('evidence-open');
    await waitFor(async () => /workspace open/.test(await cdp.panel()), 10000, 'workspace open');
    await cdp.click('evidence-start');
    await waitFor(async () => /capture active/.test(await cdp.panel()), 30000, 'capture started');
    await cdp.click('evidence-stop');
    const s1ok = await waitFor(async () =>
        /stop: complete coverage=partial/.test(await cdp.panel()), 30000, 'scenario 1 panel');
    report.scenarios.normal = { ok: s1ok, panel: await cdp.panel() };
    log('S1 normal:', report.scenarios.normal.panel);

    // scenario 3: INCOMPLETE — fixture workspace, status view
    writeIncompleteFixture();
    await cdp.click('evidence-open');  // reopen = rebuild incl. fixture
    await waitFor(async () => /workspace open/.test(await cdp.panel()), 10000, 'reopen');
    await cdp.click('evidence-status');
    const s3ok = await waitFor(async () => {
      const text = await cdp.panel();
      return /cap-incomplete \| terminal=incomplete/.test(text) &&
             /unconfirmed producers: 1/.test(text);
    }, 10000, 'scenario 3 panel');
    report.scenarios.incomplete = { ok: s3ok, panel: await cdp.panel() };
    log('S3 incomplete:', report.scenarios.incomplete.panel.split('\n').find((l) => /cap-incomplete/.test(l)));

    // scenario 2: STOP-TIMEOUT — 1ms deadline
    await cdp.eval('window.__xtraceE2EStopDeadline = 1');
    await cdp.click('evidence-start');
    await waitFor(async () => /capture active/.test(await cdp.panel()), 30000, 's2 started');
    await cdp.click('evidence-stop');
    const s2ok = await waitFor(async () => /TIMEOUT/.test(await cdp.panel()), 30000, 'scenario 2 timeout');
    report.scenarios.stopTimeout = { ok: s2ok, panel: await cdp.panel() };
    log('S2 stop-timeout:', report.scenarios.stopTimeout.panel);

    // scenario 4: CANCEL — long deadline stop, then cancel
    await cdp.eval('window.__xtraceE2EStopDeadline = 60000');
    await cdp.click('evidence-start');
    await waitFor(async () => /capture active/.test(await cdp.panel()), 30000, 's4 started');
    await cdp.click('evidence-stop');
    await new Promise((r) => setTimeout(r, 400));
    await cdp.click('evidence-cancel');
    const s4ok = await waitFor(async () => /cancelled/.test(await cdp.panel()), 15000, 'scenario 4 cancelled');
    report.scenarios.cancel = { ok: s4ok, panel: await cdp.panel() };
    log('S4 cancel:', report.scenarios.cancel.panel);
  } finally {
    // console + network checks for session 1
    report.session1 = {
      consoleErrors: cdp.consoleErrors,
      nonLocalRequests: cdp.networkRequests.filter((u) =>
          !/^file:|^devtools:|^about:/.test(u)),
    };
    app.child.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 1500));
  }

  // ---------- app session 2: scenario 5 RESUME ----------------------
  app = await launchApp();
  cdp = app.cdp;
  try {
    await cdp.eval(`window.__xtraceE2EWorkspace = ${JSON.stringify(workspaceRoot)}`);
    // the click must land AFTER app.js attached its handlers
    await waitFor(async () => cdp.eval(
        "document.readyState === 'complete' && " +
        "!!document.getElementById('btnEvidenceOpen') && " +
        "!!window.xtraceEvidencePanel && !!window.xtrace"), 15000,
        'session2 page ready');
    await cdp.click('evidence-open');
    const s5ok = await waitFor(async () => {
      const text = await cdp.panel();
      return /workspace open/.test(text);
    }, 15000, 'resume reopen');
    await cdp.click('evidence-status');
    const statusText = await cdp.panel();
    const hasPrior = /terminal=complete/.test(statusText) &&
                     /cap-incomplete \| terminal=incomplete/.test(statusText);
    report.scenarios.resume = { ok: s5ok && hasPrior, panel: statusText };
    log('S5 resume adopted prior captures:', hasPrior);
    report.session2 = {
      consoleErrors: cdp.consoleErrors,
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
  if (report.session1.consoleErrors.length) {
    failures.push(`session1 console errors: ${report.session1.consoleErrors.length}`);
  }
  if (report.session1.nonLocalRequests.length) {
    failures.push(`session1 non-local requests: ${report.session1.nonLocalRequests.join(',')}`);
  }
  log('console errors session1:', report.session1.consoleErrors.length,
      'session2:', report.session2.consoleErrors.length);
  if (failures.length) {
    console.error('P6-E5 UI FIVE-SCENARIO: RED —', failures.join('; '));
    console.error('evidence:', runDir);
    process.exit(1);
  }
  console.log('P6-E5 UI FIVE-SCENARIO INTERACTIVE ACCEPTANCE: GREEN');
  console.log('evidence: ' + runDir);
})().catch((e) => {
  console.error('P6-E5 UI FIVE-SCENARIO: DRIVER ERROR —', e.stack || e.message);
  process.exit(2);
});
