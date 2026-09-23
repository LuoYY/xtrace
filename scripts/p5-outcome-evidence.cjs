// P5 review fixes 1+2+4 evidence driver: launches the instrumented
// ChromiumX, loads webidl-outcome-smoke.html, stops the capture, then
// asserts on the trace:
//   B1  Element.scroll dual overload: two dispatcher entries, routing
//       facts distinguishing the selected overload (selected_overload).
//   B2  path-classified outcomes: ok / arg-error / receiver-error /
//       native-exception each present with token-paired entries.
//   R4  top-level channel: bindings events "bindings", impl events
//       "impl" (DP2: no null top-level channel anywhere).
const assert = require('node:assert/strict');
const fs = require('node:fs'); const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const exec = path.join(root, 'chromium/src/out/XTraceIntegration/ChromiumX.app/Contents/MacOS/Chromium');
const runDir = fs.mkdtempSync(path.join(root, 'chromium/src/out/XTraceIntegration/validation', 'p5-outcome-'));
const trace = path.join(runDir, 'trace.ndjson');
class PipeClient {
  constructor(child) { this.child = child; this.nextId = 0; this.pending = new Map(); let buffered = Buffer.alloc(0);
    child.stdio[4].on('data', chunk => { buffered = Buffer.concat([buffered, chunk]); let boundary;
      while ((boundary = buffered.indexOf(0)) !== -1) { const raw = buffered.subarray(0, boundary).toString('utf8'); buffered = buffered.subarray(boundary + 1); if (!raw) continue;
        const message = JSON.parse(raw); if (message.id) { const request = this.pending.get(message.id); if (!request) continue; this.pending.delete(message.id);
          if (message.error) request.reject(new Error(JSON.stringify(message.error))); else request.resolve(message.result); } } });
    this.exit = new Promise(r => this.child.once('exit', r)); }
  send(method, params = {}, sessionId) { return new Promise((resolve, reject) => { const id = ++this.nextId;
    const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 60000);
    this.pending.set(id, { resolve, reject, timer });
    this.child.stdio[3].write(JSON.stringify({ id, method, params, sessionId }) + '\0'); }); }
}
const source = `import importlib.util, pathlib, socketserver\np = pathlib.Path(${JSON.stringify(path.resolve(__dirname, 'serve_test_page.py'))})\nspec = importlib.util.spec_from_file_location('s', p)\nm = importlib.util.module_from_spec(spec)\nspec.loader.exec_module(m)\nwith socketserver.TCPServer(('127.0.0.1', 0), m.make_test_page_handler(p.parent.parent / 'test-pages')) as server:\n print(server.server_address[1], flush=True)\n server.serve_forever()\n`;
const server = spawn('python3', ['-u', '-c', source], { stdio: ['ignore', 'pipe', 'ignore'] });
(async () => {
  const port = await new Promise(r => { let t = ''; server.stdout.on('data', c => { t += c; if (t.includes('\n')) r(Number(t.trim())); }); });
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('XTRACE_')));
  const args = ['--headless=new','--remote-debugging-pipe','--no-first-run','--xtrace-enable',`--xtrace-file=${trace}`,
    '--xtrace-categories=reverse,fingerprint','--xtrace-causality=sync',
    `--user-data-dir=${path.join(runDir,'p')}`,'about:blank'];
  const errFd = fs.openSync(path.join(runDir, 'stderr.log'), 'w');
  const child = spawn(exec, args, { env, stdio: ['ignore','ignore',errFd,'pipe','pipe'] });
  fs.closeSync(errFd);
  const client = new PipeClient(child);
  const { targetId } = await client.send('Target.createTarget', { url: `http://127.0.0.1:${port}/webidl-outcome-smoke.html` });
  const { sessionId } = await client.send('Target.attachToTarget', { targetId, flatten: true });
  await client.send('Page.enable', {}, sessionId);
  await new Promise(r => setTimeout(r, 6000));
  const evalRes = await client.send('Runtime.evaluate', { expression: "document.getElementById('result') ? document.getElementById('result').textContent : ''" }, sessionId);
  const pageResults = JSON.parse(evalRes.result.value || '{}');
  const stop = await client.send('XTrace.stopCapture');
  await client.send('Browser.close');
  await client.exit;
  server.kill();

  const lines = fs.readFileSync(trace, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  const events = lines.filter(e => e.schema_version === 3);
  const entries = events.filter(e => e.webidl_entry);
  const outcomes = events.filter(e => e.webidl_outcome);
  const report = {
    runDir: path.basename(runDir),
    terminal: stop.state,
    events: events.length,
    entries: entries.length,
    outcomes: outcomes.length,
    pageResults,
  };

  // --- terminal + validator gate -------------------------------------
  assert(stop.state === 'complete', `terminal=${stop.state}`);
  const val = spawnSync('python3', [
      path.join(__dirname, 'validate_trace.py'),
      '--schema-version', '3', '--profile', 'generic-vmp',
      trace], { encoding: 'utf8', timeout: 120000 });
  assert(val.status === 0, `validator failed:\n${val.stdout}\n${val.stderr}`);

  // --- R4: top-level channel discipline ------------------------------
  for (const e of events) {
    if (e.webidl_entry || e.webidl_outcome) {
      assert.equal(e.channel, 'bindings', `bindings event top-level channel: ${e.api}`);
    }
  }
  const implEvents = events.filter(e => !e.webidl_entry && !e.webidl_outcome && !e.ignition);
  assert(implEvents.length > 0, 'expected impl-channel events (handwritten hooks)');
  for (const e of implEvents) {
    assert.equal(e.channel, 'impl', `impl event top-level channel: ${e.api}`);
  }
  report.implChannelEvents = implEvents.length;

  // --- B2: token pairing (producer-scoped: call_token is a per-process
  // sequence, and background internal pages share the trace) ------------
  const outcomeByToken = new Map();
  for (const o of outcomes) outcomeByToken.set(`${o.producer_id}:${o.webidl_outcome.call_token}`, o);
  const entryTokens = new Set(entries.map(en => `${en.producer_id}:${en.webidl_entry.call_token}`));
  for (const en of entries) {
    const key = `${en.producer_id}:${en.webidl_entry.call_token}`;
    assert(outcomeByToken.has(key), `entry without paired outcome: ${en.api} key=${key}`);
  }
  for (const o of outcomes) {
    const key = `${o.producer_id}:${o.webidl_outcome.call_token}`;
    assert(entryTokens.has(key), `outcome without paired entry: key=${key}`);
  }
  const kinds = {};
  for (const o of outcomes) kinds[o.webidl_outcome.outcome] = (kinds[o.webidl_outcome.outcome] || 0) + 1;
  report.outcomeKinds = kinds;
  for (const required of ['ok', 'arg-error', 'receiver-error', 'native-exception']) {
    assert(kinds[required] > 0, `outcome kind missing: ${required} (have ${JSON.stringify(kinds)})`);
  }

  // --- B1: Element.scroll dual overload routing ------------------------
  const scrollEntries = entries.filter(e => e.api === 'Element.scroll');
  assert(scrollEntries.length >= 2, `Element.scroll entries: ${scrollEntries.length}`);
  for (const en of scrollEntries) {
    assert.equal(en.webidl_entry.entry_kind, 'overload-dispatcher', 'scroll entry kind');
    assert.equal(en.webidl_entry.overload_count, 2, 'scroll overload_count');
  }
  const scrollOutcomes = scrollEntries.map(en => outcomeByToken.get(`${en.producer_id}:${en.webidl_entry.call_token}`));
  const routed = scrollOutcomes.map(o => o.webidl_outcome.selected_overload);
  assert(routed.includes('0') || routed.includes(0), `options-form routing fact missing: ${JSON.stringify(routed)}`);
  assert(routed.includes('1') || routed.includes(1), `xy-form routing fact missing: ${JSON.stringify(routed)}`);
  report.scrollRouting = routed;

  // --- B2 spot checks per probe case -----------------------------------
  const ctorOutcomes = pairOutcomes(outcomeByToken, entries, 'URL.constructor');
  assert(ctorOutcomes.some(o => o.outcome === 'native-exception'), 'URL.constructor native-exception outcome');
  assert(ctorOutcomes.some(o => o.outcome === 'arg-error'), 'URL.constructor arg-error outcome');
  assert(ctorOutcomes.some(o => o.outcome === 'call-form-error'), 'URL.constructor call-form-error outcome');
  const scrollPair = pairOutcomes(outcomeByToken, entries, 'Element.scroll');
  assert(scrollPair.some(o => o.outcome === 'receiver-error'), 'Element.scroll receiver-error outcome');
  assert(scrollPair.every(o => o.outcome === 'ok' || o.outcome === 'receiver-error'), 'scroll outcomes classified');

  fs.writeFileSync(path.join(runDir, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  console.log('P5 OUTCOME EVIDENCE: PASS');
})().catch(e => { console.error('P5 OUTCOME EVIDENCE: FAIL —', e.message); process.exit(1); });

function pairOutcomes(outcomeByToken, entries, api) {
  const res = [];
  for (const en of entries.filter(x => x.api === api)) {
    const o = outcomeByToken.get(`${en.producer_id}:${en.webidl_entry.call_token}`);
    if (o) res.push(o.webidl_outcome);
  }
  return res;
}
