'use strict';
// P6-R1 integration + adapter gates — the composition root on a REAL
// ChromiumX (live handshake, callTool through the Broker, negotiated
// toolSchemas with state), streaming window contracts on synthetic and
// REAL captures (B3), skill boundary (B6), evidence jump (M6), and the
// agent loop's hardened guardrails (B4).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createWorkspace } = require('../src/workspace');
const { createEvidenceIndex } = require('../src/evidence-index');
const { createAGroupAdapters } = require('../src/adapters-agroup');
const { createHost } = require('../src/host');
const { createAgentLoop } = require('../src/agent-loop');
const { createSlicer, relevance, RELEVANCE_WEIGHTS }
  = require('../src/slicer');

const ROOT = path.resolve(__dirname, '..', '..');
const EXE = path.join(ROOT, 'chromium/src/out/XTraceIntegration/ChromiumX.app/Contents/MacOS/Chromium');

// ---- fixtures ---------------------------------------------------------
function synthCapture(root, name, { ignitionCount = 0, bindingsCount = 0,
                                    prefixPad = 0, traceName = 'trace.ndjson' }) {
  const dir = path.join(root, 'traces', name);
  fs.mkdirSync(dir, { recursive: true });
  const events = [];
  for (let i = 0; i < prefixPad; i++) {
    events.push(baseEvent(name, i + 1, { api: `Pad.event${i % 7}` }));
  }
  const seq = () => events.length + 1;
  for (let i = 0; i < ignitionCount; i++) {
    events.push(baseEvent(name, seq(), { api: 'Ignition.execute',
        ignition: { script_id: '9', bytecode_version: '5',
                   bytecode_offset: '0', opcode: 'GetNamedProperty',
                   tier: 'ignition', activation_ref: null } }));
  }
  for (let i = 0; i < bindingsCount; i++) {
    events.push(baseEvent(name, seq(), { api: 'WebIDL.entry',
        channel: 'bindings' }));
  }
  const trace = path.join(dir, traceName);
  fs.writeFileSync(trace, events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  const manifestName = traceName.replace(/\.ndjson$/, '.manifest.json');
  fs.writeFileSync(path.join(dir, manifestName), JSON.stringify({
    schema_version: 3, capture_id: name, accounting_model: '2',
    observation_coverage: 'partial',
    terminal: { state: 'complete', reason: null },
    counts: { eligible: String(events.length), enqueued: String(events.length),
              dropped: '0', accepted: String(events.length),
              written: String(events.length), failed: '0',
              sampled_out: '2', partial_observations: '1' },
    producers: [],
  }));
  return dir;
}

function baseEvent(producer, seq, extra) {
  return {
    schema_version: 3, producer_id: `rtx:${producer}`, process_epoch: '1',
    producer_seq: String(seq), writer_seq: '1', config_generation: '1',
    mono_time_us: String(seq), wall_time_us: String(seq), pid: 1, tid: 1,
    category: 'reverse', phase: 'call', api: 'X.event',
    args: [], stack: [], attribution: { status: 'unresolved' },
    causality: { kind: 'singleton', call_id: `s:${seq}`, parent_id: null,
                 depth: 0, duration_us: null },
    ...extra,
  };
}

function freshIndex(root) {
  const ws = createWorkspace(root);
  return createEvidenceIndex(path.join(ws.dir('index'), 'index.db'));
}

// ---- B3: streaming window contract + page-sum equality ------------------
test('B3 gate: predicates push down; page sums equal file truth', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'r1-b3-'));
  // ignition rows live AFTER a 6000-row prefix — the old 5000-window
  // was structurally blind to this shape
  synthCapture(root, 'cap-b3',
      { prefixPad: 6000, ignitionCount: 40, bindingsCount: 25 });
  const index = freshIndex(root);
  index.rebuildFromDir(path.join(root, 'traces'));
  const captureId = index.listCaptures()[0].capture_id;

  // jsvmp_query page-sums to the file truth
  let sum = 0, cursor = null, pages = 0;
  for (;;) {
    const scan = index.scanEvents(captureId, {
      fromSeq: cursor, maxRows: 7, maxBytes: 1 << 20,
      predicates: { ignition: true } });
    sum += scan.rows.length;
    pages += 1;
    assert.ok(typeof scan.window_complete === 'boolean');
    assert.equal(scan.total_events, 6065);
    if (scan.window_complete) {
      break;
    }
    assert.ok(scan.next_cursor != null, 'cursor present when incomplete');
    cursor = scan.next_cursor;
    assert.ok(pages < 20, 'pagination terminates');
  }
  assert.equal(sum, 40, 'sum(matched over pages) == ignition truth');

  // bindings predicate finds rows the old take-then-filter missed
  const bindings = index.scanEvents(captureId,
      { maxRows: 1000, maxBytes: 1 << 20, predicates: { bindings: true } });
  assert.equal(bindings.rows.length, 25);
  assert.ok(bindings.rows.every((r) =>
      r.event.channel === 'bindings' || /WebIDL/.test(r.event.api || '')));

  // api predicate + cursor strictly-after semantics
  const page1 = index.scanEvents(captureId,
      { maxRows: 10, predicates: { api: 'Pad.event3' } });
  assert.ok(page1.rows.every((r) => r.event.api === 'Pad.event3'));
  const page2 = index.scanEvents(captureId,
      { fromSeq: page1.next_cursor, maxRows: 10,
        predicates: { api: 'Pad.event3' } });
  for (const r of page2.rows) {
    // inclusive revisit: the boundary row itself heads page 2, later
    // rows are strictly greater
    assert.ok(Number(r.producer_seq) >= page1.next_cursor);
  }
  if (page2.rows.length > 1) {
    assert.ok(Number(page2.rows[1].producer_seq) > page1.next_cursor);
  }
  index.close();
});

test('B3 real-capture gate: page sums equal on-disk truth (large file, deep rows)', () => {
  // a REAL accepted-p55 capture: ignition rows start ~7k lines in and
  // total in the tens of thousands — the exact shape B3 was blind on.
  const candidates = ['p55-e7-ERduFv', 'p55-e7-rxjiQM', 'p55-e7-vQZRf3'];
  const validation = path.join(ROOT,
      'chromium/src/out/XTraceIntegration/validation');
  let dir = null;
  for (const c of candidates) {
    const d = path.join(validation, c);
    if (fs.existsSync(path.join(d, 'trace.ndjson'))) {
      dir = d;
      break;
    }
  }
  if (!dir) {
    const any = fs.readdirSync(validation)
        .filter((d) => d.startsWith('p55-e7-'))
        .map((d) => path.join(validation, d))
        .filter((d) => fs.existsSync(path.join(d, 'trace.ndjson')));
    assert.ok(any.length, 'a real p55-e7 capture exists');
    dir = any[0];
  }
  const truth = countMatches(dir, (e) => Boolean(e.ignition));
  const bindingsTruth = countMatches(dir, (e) =>
      e.channel === 'bindings' || /WebIDL\.entry/.test(e.api || ''));
  assert.ok(truth > 1000, `real capture has many ignition rows (${truth})`);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'r1-b3r-'));
  fs.cpSync(dir, path.join(root, 'traces', 'real'),
      { recursive: true, dereference: false });
  const index = freshIndex(root);
  const rebuilt = index.rebuildFromDir(path.join(root, 'traces'));
  assert.equal(rebuilt[0].eventCount, countLines(dir), 'index saw every line');

  const captureId = rebuilt[0].captureId;
  let sum = 0, cursor = null, guard = 0;
  for (;;) {
    const scan = index.scanEvents(captureId, {
      fromSeq: cursor, maxRows: 500, maxBytes: 1 << 20,
      predicates: { ignition: true } });
    sum += scan.rows.length;
    if (scan.window_complete) {
      break;
    }
    cursor = scan.next_cursor;
    assert.ok(++guard < 200, 'pagination terminates');
  }
  assert.equal(sum, truth,
      'page-sum equality: sum(jsvmp_query pages) == ignition truth');
  const bindings = index.scanEvents(captureId,
      { maxRows: 1 << 20, maxBytes: 1 << 26, predicates: { bindings: true } });
  assert.equal(bindings.rows.length, bindingsTruth,
      'webapi_query no longer returns zero rows');
  index.close();
});

function countMatches(dir, pred) {
  let n = 0;
  for (const line of fs.readFileSync(path.join(dir, 'trace.ndjson'),
      'utf8').split('\n')) {
    if (!line.trim()) {
      continue;
    }
    try {
      if (pred(JSON.parse(line))) {
        n += 1;
      }
    } catch { /* unparseable lines are not events for anyone */ }
  }
  return n;
}
function countLines(dir) {
  return fs.readFileSync(path.join(dir, 'trace.ndjson'), 'utf8')
      .split('\n').filter((l) => l.trim()).length;
}

// ---- B6: skill/notes boundary -------------------------------------------
test('B6 gate: symlink / absolute / .. escapes all rejected via the realpath gate', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'r1-b6-'));
  const ws = createWorkspace(root);
  const index = freshIndex(root);
  index.rebuildFromDir(path.join(root, 'traces'));
  const adapters = createAGroupAdapters({ workspace: ws, index });
  const byName = Object.fromEntries(adapters.map((a) => [a.name, a]));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'r1-out-'));
  fs.writeFileSync(path.join(outside, 'secret.txt'),
      'OUTSIDE-OF-WORKSPACE-SECRET');
  const skills = path.join(ws.root, 'skills');
  fs.mkdirSync(skills, { recursive: true });
  fs.symlinkSync(outside, path.join(skills, 'evil'));
  const good = path.join(skills, 'good');
  fs.mkdirSync(good, { recursive: true });
  fs.writeFileSync(path.join(good, 'SKILL.md'), '# good skill');

  const call = (name, args) => byName[name].run(args);

  // symlink escape (the exact B6 probe)
  return call('skill_read_resource',
      { name: 'evil', resource: 'secret.txt' })
    .then(() => { throw new Error('symlink escape MUST throw'); },
          (e) => { assert.match(e.message, /escapes the workspace boundary/); })
    // absolute-path resource
    .then(() => call('skill_read_resource',
        { name: 'good', resource: path.join(outside, 'secret.txt') }))
    .then(() => { throw new Error('absolute path MUST throw'); },
        (e) => { assert.ok(/escapes the workspace|invalid/.test(e.message)); })
    // .. traversal
    .then(() => call('skill_read_resource',
        { name: 'good', resource: '../evil/secret.txt' }))
    .then(() => { throw new Error('.. escape MUST throw'); },
        (e) => { assert.match(e.message,
            /escapes the workspace boundary|invalid resource name/); })
    // workspace layer agrees on the same paths (no two implementations)
    .then(() => {
      assert.throws(() => ws.assertInside(
          path.join(skills, 'evil', 'secret.txt'), 'p'),
          /escapes the workspace boundary/);
      return call('skill_get', { name: 'good' });
    })
    .then((out) => {
      assert.match(out.content, /good skill/);
      assert.equal(out.truncated, false);
      index.close();
    });
});

// ---- M6: evidence_jump ----------------------------------------------------
test('M6 gate: evidence_jump resolves line + byte_offset via the index trace_file', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'r1-m6-'));
  // NON-default filename — B5's exact blind spot
  synthCapture(root, 'cap-jump',
      { prefixPad: 50, traceName: 'trace-on.ndjson' });
  const ws = createWorkspace(root);
  const index = freshIndex(root);
  index.rebuildFromDir(path.join(root, 'traces'));
  const captureId = index.listCaptures()[0].capture_id;
  const adapters = createAGroupAdapters({ workspace: ws, index });
  const jump = adapters.find((a) => a.name === 'evidence_jump');

  const first = index.scanEvents(captureId, { maxRows: 1,
      maxBytes: 1 << 20 }).rows[0];
  const ref = `${captureId}|${first.producer_id}|${first.producer_seq}`;
  return jump.run({ ref }).then((out) => {
    assert.equal(out.line, 1);
    assert.ok(Number.isInteger(out.byte_offset) && out.byte_offset >= 0);
    assert.equal(out.event.api, first.event.api);
    assert.ok(out.trace_file.endsWith('trace-on.ndjson'),
        'resolves via the index trace_file, not a hardcoded name');
    return jump.run({ ref: `${captureId}|nobody|999` })
        .then(() => { throw new Error('unknown ref must throw'); },
              (e) => assert.match(e.message, /not found/));
  }).then(() => index.close());
});

// ---- B4: slicer robustness ------------------------------------------------
test('B4 gate: cap sweep x three shapes never throws, bytes <= cap, drops disclosed', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'r1-b4-'));
  synthCapture(root, 'cap-sweep', { prefixPad: 300, ignitionCount: 40 });
  const ws = createWorkspace(root);
  const index = freshIndex(root);
  index.rebuildFromDir(path.join(root, 'traces'));
  const captureId = index.listCaptures()[0].capture_id;
  const { minimalEnvelopeBytes } = require('../src/slicer');
  const floor = minimalEnvelopeBytes();
  const caps = [32, 64, 100, 128, 150, 200, 512, 4096];
  for (const cap of caps) {
    const slicer = createSlicer({ index, budget: {
      manifest_summary_bytes: cap, evidence_slice_bytes: cap,
      evidence_slice_rows: 5, index_results_bytes: cap } });
    for (const make of [
      () => slicer.manifestSummary(captureId),
      () => slicer.evidenceSlice(captureId),
      () => slicer.indexResults(
          [{ a: 'x'.repeat(200) }, { b: 'y'.repeat(200) }, { c: 1 }]),
    ]) {
      let slice;
      assert.doesNotThrow(() => { slice = make(); },
          `cap=${cap} must never throw`);
      assert.ok(slice.bytes <= Math.max(cap, floor),
          `bytes ${slice.bytes} <= cap ${cap} (minimal-envelope floor)`);
      JSON.parse(JSON.stringify(slice));   // never invalid JSON
      if (slice.bytes >= cap - 8 && slice.truncated) {
        assert.ok(Array.isArray(slice.dropped_fields),
            'drops disclosed at hard caps');
      }
    }
  }
  index.close();
});

test('M11 gate: relevance uses normalized fields; shuffle negative control', () => {
  const tapRow = { api: 'ValueTap.observe', phase: 'call', causality: 'singleton',
    event: { value_tap: { v: 1 } } };
  const pairedReturn = { api: 'X.entry', phase: 'return', causality: 'paired',
    event: {} };
  const plain = { api: 'X.entry', phase: 'call', causality: 'singleton',
    event: {} };
  assert.ok(relevance(tapRow) > relevance(plain));
  assert.equal(relevance(pairedReturn),
      RELEVANCE_WEIGHTS.paired_return,
      'v3 object-form causality normalized: paired return weights live');
  // negative control: zeroed weights must flip the ordering verdict
  const before = relevance(tapRow) > relevance(plain);
  const weights = { ...RELEVANCE_WEIGHTS, value_tap: 0 };
  const shuffled = (row) => {
    const e = row.event || {};
    let s = 0;
    if (e.value_tap) { s += weights.value_tap; }
    if (/dump/i.test(String(e.api || ''))) { s += weights.dump_api; }
    if (e.ignition) { s += weights.ignition; }
    if (row.causality === 'paired' && row.phase === 'return') {
      s += weights.paired_return;
    }
    return s;
  };
  assert.equal(before, true);
  assert.equal(shuffled(tapRow) > shuffled(plain), false,
      'weight-table negative control: tampering flips the verdict');
});

// ---- B4: agent loop never unwinds on slice errors / tiny budgets ----------
test('B4 gate: tiny slice budgets + slice errors never reject the loop', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'r1-loop-'));
  synthCapture(root, 'cap-loop', { prefixPad: 100, ignitionCount: 20 });
  const ws = createWorkspace(root);
  const index = freshIndex(root);
  index.rebuildFromDir(path.join(root, 'traces'));
  const captureId = index.listCaptures()[0].capture_id;
  const adapters = createAGroupAdapters({ workspace: ws, index });
  const { createBroker, TIERS } = require('../src/broker');
  const broker = createBroker({ workspace: ws });
  const tools = adapters.map((t) => broker.register(t));

  const model = async (state) => {
    if (state.iteration === 1) {
      return { type: 'slice', shape: 'no-such-shape',
               capture_id: captureId };      // makeSlice throws
    }
    if (state.iteration === 2) {
      return { type: 'slice', shape: 'manifest-summary',
               capture_id: 'unknown-capture-xyz' };  // throws too
    }
    return { type: 'final', answer: { survived: true,
        sawFirstError: typeof state.last?.error } };
  };
  const loop = createAgentLoop({ broker, tools, index, workspace: ws,
      model, limits: { context_bytes: 4096,
                       slice_budget: { manifest_summary_bytes: 64,
                                       evidence_slice_bytes: 64,
                                       evidence_slice_rows: 2,
                                       index_results_bytes: 64 } } });
  const out = await loop.run();
  assert.ok(['complete', 'no-progress', 'max-iterations']
      .includes(out.status), `loop settled, not rejected (${out.status})`);
  assert.equal(out.status, 'complete');
  assert.ok(out.log.some((l) => l.type === 'slice-error'),
      'slice errors are reported, not thrown');
  assert.deepEqual(out.answer.survived, true);
  index.close();
});

// ---- composition root on the real browser ---------------------------------
test('R1-1 integration: composition root — one broker, callTool, negotiated schemas', { timeout: 90000 }, async () => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'r1-root-'));
  fs.mkdirSync(workspaceRoot, { recursive: true });
  const traceFile = path.join(workspaceRoot, 'traces', 'r1-root',
      'trace.ndjson');
  const host = await createHost({
    executable: EXE,
    workspaceRoot,
    traceFile,
    browserArgs: ['about:blank'],
  });
  try {
    assert.ok(host.version && typeof host.version.product === 'string');
    // negotiated schemas carry state (M1)
    const schemas = await host.toolSchemas();
    assert.ok(schemas.length > 0);
    assert.ok(schemas.every((s) => typeof s.state === 'string'));
    // unavailable tools are NOT on the model surface but ARE disclosed
    assert.ok(!schemas.some((s) => s.name === 'jsvmp_disassemble'));
    const caps = await host.capabilities();
    assert.ok(caps.tools.some((t) => t.name === 'jsvmp_disassemble' &&
        t.state === 'unavailable'));

    // read entry via callTool leaves a granted row (B1 read side)
    const out = await host.callTool('trace_summary', {},
        { origin: 'ui' });
    assert.ok(Array.isArray(out));

    // side-effect entry via callTool: ui-direct-click executes with
    // honest basis; the ledger binds startCapture to the audit
    const g = await host.callTool('jsvmp_trace',
        { action: 'start', max_taps: 5 },
        { origin: 'ui', reason: 'R1 composition-root probe',
          basisHint: 'ui-direct-click' });
    assert.equal(g.state, 'active');
    const stop = await host.callTool('jsvmp_trace', { action: 'stop' },
        { origin: 'ui', reason: 'R1 composition-root probe',
          basisHint: 'ui-direct-click' });
    // D-P6-3: the REAL pair assertion (was a tautological includes ||
    // != null) — transport complete AND a non-empty coverage axis
    assert.equal(stop.pair.terminal, 'complete');
    assert.ok(stop.pair.coverage, 'coverage axis present');

    const ledger = fs.readFileSync(host.broker.ledgerPath, 'utf8')
        .trim().split('\n').map((l) => JSON.parse(l));
    const executed = ledger.filter((e) => e.decision === 'executed');
    assert.ok(executed.some((e) => e.tool === 'jsvmp_trace'));
    const confirmed = ledger.filter((e) => e.decision === 'confirmed');
    assert.ok(confirmed.every((c) => c.basis === 'ui-direct-click'));
    assert.ok(ledger.filter((e) => e.decision === 'granted')
        .some((e) => e.tool === 'trace_summary'));
  } finally {
    await host.close();
  }
  assert.equal(host.closed, true);
  await assert.rejects(() => host.send('Browser.getVersion'), /closed/i);
});


// ---- R2-3 anchor: THREE producers, one predicate, page sums exact ----
test('R2-3 gate: three producers x one predicate — lossless page sums', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'r2-cursor-'));
  const dir = path.join(root, 'traces', 'cap-three');
  fs.mkdirSync(dir, { recursive: true });
  const events = [];
  let seq = 0;
  // interleave three producers; every row matches the predicate
  const producers = ['rtx:a:1:1', 'rtx:b:2:1', 'bnet:c:3:1'];
  for (let i = 0; i < 90; i++) {
    seq += 1;
    events.push(baseEvent(producers[i % 3], seq,
        { api: 'Document.cookie.set' }));
  }
  fs.writeFileSync(path.join(dir, 'trace.ndjson'),
      events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  fs.writeFileSync(path.join(dir, 'trace.manifest.json'), JSON.stringify({
    schema_version: 3, capture_id: 'cap-three', accounting_model: '2',
    observation_coverage: 'partial',
    terminal: { state: 'complete', reason: null },
    counts: { eligible: '90', enqueued: '90', dropped: '0',
              accepted: '90', written: '90', failed: '0',
              sampled_out: '0', partial_observations: '0' },
    producers: [],
  }));
  const index = freshIndex(root);
  index.rebuildFromDir(path.join(root, 'traces'));
  const captureId = index.listCaptures()[0].capture_id;
  const seen = [];
  let cursor = null, pages = 0, sum = 0;
  for (;;) {
    const scan = index.scanEvents(captureId, {
      fromLine: cursor, maxRows: 7, maxBytes: 1 << 20,
      predicates: { api: 'Document.cookie.set' } });
    sum += scan.rows.length;
    seen.push(...scan.rows.map((r) => `${r.producer_id}#${r.producer_seq}`));
    pages += 1;
    if (scan.window_complete) {
      break;
    }
    assert.ok(scan.next_cursor != null);
    cursor = scan.next_cursor;
    assert.ok(pages < 40, 'terminates');
  }
  assert.equal(sum, 90, 'sum == truth (three producers)');
  assert.equal(new Set(seen).size, 90, 'zero duplicates across producers');
  index.close();
});

// m-R3-6: EXISTENCE check only — the real stop-timeout gates are the
// CDP_TIMEOUT + dead-browser deadline unit tests in r1-core and E5 S2;
// do NOT count this toward behavioral gate coverage.
test('existence note (not a behavioral gate): stop-timeout strings ship', () => {
  const fs2 = require('node:fs');
  const path2 = require('node:path');
  const files = [
    path2.join(ROOT, 'xtrace-host/test/r1-core.test.js'),
    path2.join(ROOT, 'scripts/p6-e5-ui-scenarios.cjs'),
  ];
  for (const f of files) {
    assert.ok(fs2.existsSync(f), f);
    assert.ok(/stop-timeout/.test(fs2.readFileSync(f, 'utf8')),
        `stop-timeout gate present in ${path2.basename(f)}`);
  }
});
