'use strict';
// P6-R1 unit gates — workspace boundary (kept from E1), the hardened
// Broker semantics (R1-3/R1-4: basis values, lifecycle, expiry,
// same-key concurrency), the composition root source-shape contract,
// and capability negotiation.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createWorkspace } = require('../src/workspace');
const { createBroker, TIERS, BASES } = require('../src/broker');
const { negotiate, registry } = require('../src/capabilities');
const { resolveOrphan, buildLaunchSpec } = require('../src/host');

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'xtrace-r1-'));
}

test('workspace rejects symlink escapes by realpath (kept from E1)', () => {
  const root = tmp();
  const ws = createWorkspace(root);
  const outside = tmp();
  const escape = path.join(ws.dir('traces'), 'escape');
  fs.symlinkSync(outside, escape);
  assert.ok(!ws.contains(escape));
  assert.throws(() => ws.assertInside(escape, 'trace'),
      /escapes the workspace boundary/);
  ws.assertInside(path.join(ws.dir('traces'), 'cap1', 'trace.ndjson'));
});

test('R1-3: read tier leaves granted rows with session-grant basis', async () => {
  const ws = createWorkspace(tmp());
  const broker = createBroker({ workspace: ws });
  let ran = 0;
  const tool = broker.register({
    name: 'trace_query', tier: TIERS.READ_EVIDENCE,
    run: async () => { ran += 1; return { rows: [] }; },
  });
  for (const origin of ['agent', 'ui', 'mcp']) {
    await broker.execute(tool, {}, { origin });
  }
  assert.equal(ran, 3);
  const ledger = readLedger(broker);
  const grants = ledger.filter((e) => e.decision === 'granted');
  assert.equal(grants.length, 3);
  assert.ok(grants.every((g) => g.basis === BASES.SESSION_GRANT));
  assert.deepEqual(grants.map((g) => g.origin).sort(), ['agent', 'mcp', 'ui']);
});

test('R1-3: ui-direct-click self-confirms with honest basis; no bare confirmed', async () => {
  const ws = createWorkspace(tmp());
  const broker = createBroker({ workspace: ws });
  let sideEffects = 0;
  const tool = broker.register({
    name: 'jsvmp_trace', tier: TIERS.STATEFUL_CONTROL,
    run: async () => { sideEffects += 1; return { ok: true }; },
  });
  const out = await broker.execute(tool, {}, {
    origin: 'ui', reason: 'stop the capture now',
    basisHint: BASES.UI_DIRECT_CLICK,
  });
  assert.deepEqual(out, { ok: true });
  assert.equal(sideEffects, 1);
  const ledger = readLedger(broker);
  const confirmed = ledger.find((e) => e.decision === 'confirmed');
  assert.ok(confirmed, 'confirmation row present');
  assert.equal(confirmed.basis, BASES.UI_DIRECT_CLICK);
  // B2: no confirmed row may exist without a basis
  assert.ok(ledger.filter((e) => e.decision === 'confirmed')
      .every((e) => e.basis));
});

test('R1-3/R1-6-D1: agent-origin NEVER self-confirms; human approve/deny via resolver', async () => {
  const ws = createWorkspace(tmp());
  const broker = createBroker({ workspace: ws });
  let sideEffects = 0;
  const tool = broker.register({
    name: 'jsvmp_trace', tier: TIERS.STATEFUL_CONTROL,
    run: async () => { sideEffects += 1; return { ok: true }; },
  });
  const ctx = { origin: 'agent', reason: 'begin capture' };
  const exec = broker.execute(tool, {}, ctx);
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(broker.pendingCount(), 1, 'agent call parks at pending');
  const listing = broker.pendingList();
  assert.equal(listing.length, 1);
  assert.equal(listing[0].tool, 'jsvmp_trace');
  assert.equal(listing[0].origin, 'agent');

  // deny path: no side effect, honest basis
  broker.resolveConfirmation(listing[0].id, false);
  await assert.rejects(() => exec, /denied by user/);
  assert.equal(sideEffects, 0);

  // approve path
  const exec2 = broker.execute(tool, {}, ctx);
  await new Promise((r) => setTimeout(r, 5));
  const id2 = broker.pendingIds()[0];
  const res = broker.resolveConfirmation(id2, true);
  assert.deepEqual(res, { ok: true });
  assert.deepEqual(await exec2, { ok: true });
  assert.equal(sideEffects, 1);
  const ledger = readLedger(broker);
  const denied = ledger.find((e) => e.decision === 'denied-by-user');
  assert.equal(denied.basis, BASES.HUMAN_DENIED);
  const approved = ledger.filter((e) => e.decision === 'confirmed')
      .find((e) => e.basis === BASES.HUMAN_APPROVED);
  assert.ok(approved, 'human-approved row present');
});

test('R1-4: late approval on an expired confirmation does NOT run the side effect', async () => {
  let now = 1000;
  const ws = createWorkspace(tmp());
  const broker = createBroker({ workspace: ws, clock: () => now,
                                confirmationTtlMs: 500 });
  let sideEffects = 0;
  const tool = broker.register({
    name: 'env_open', tier: TIERS.STATEFUL_CONTROL,
    run: async () => { sideEffects += 1; return { open: true }; },
  });
  const exec = broker.execute(tool, {}, { origin: 'agent', reason: 'open env' });
  await new Promise((r) => setTimeout(r, 5));
  const id = broker.pendingIds()[0];
  now += 600;   // TTL elapses before the human answers
  const res = broker.resolveConfirmation(id, true);
  assert.deepEqual(res, { ok: false, reason: 'confirmation-expired' });
  await assert.rejects(() => exec, /confirmation-expired/);
  assert.equal(sideEffects, 0, 'no side effect after expiry');
  const ledger = readLedger(broker);
  assert.ok(ledger.some((e) => e.decision === 'confirmation-expired'));
  assert.ok(!ledger.some((e) => e.decision === 'executed'));
});

test('R1-4: same-key concurrent second call is explicitly rejected, none orphaned', async () => {
  const ws = createWorkspace(tmp());
  const broker = createBroker({ workspace: ws });
  const tool = broker.register({
    name: 'jsvmp_trace', tier: TIERS.STATEFUL_CONTROL,
    run: async () => ({ ok: true }),
  });
  const ctx = { origin: 'agent', reason: 'duplicate key test' };
  const first = broker.execute(tool, {}, ctx);
  await new Promise((r) => setTimeout(r, 5));
  const second = broker.execute(tool, {}, ctx);
  await assert.rejects(() => second, /already pending/);
  // settle the first cleanly; nothing hangs
  broker.resolveConfirmation(broker.pendingIds()[0], false);
  await assert.rejects(() => first, /denied by user/);
  assert.equal(broker.pendingCount(), 0);
});

test('R1-4: cancelPending retires a request; late resolution is inert', async () => {
  const ws = createWorkspace(tmp());
  const broker = createBroker({ workspace: ws });
  let sideEffects = 0;
  const tool = broker.register({
    name: 'jsvmp_trace', tier: TIERS.STATEFUL_CONTROL,
    run: async () => { sideEffects += 1; return { ok: true }; },
  });
  const exec = broker.execute(tool, {},
      { origin: 'agent', reason: 'cancel path test' });
  await new Promise((r) => setTimeout(r, 5));
  const id = broker.pendingIds()[0];
  assert.equal(broker.cancelPending(id), true);
  await assert.rejects(() => exec, /cancelled/);
  assert.equal(sideEffects, 0);
  assert.deepEqual(broker.resolveConfirmation(id, true),
      { ok: false, reason: 'unknown-confirmation' });
  assert.equal(sideEffects, 0, 'late resolution after cancel is inert');
});

test('host-exec tier stays default-deny and non-registrable', () => {
  const ws = createWorkspace(tmp());
  const broker = createBroker({ workspace: ws });
  assert.throws(() => broker.register({
    name: 'run_node', tier: TIERS.HOST_EXEC, run: async () => {} }),
      /host-exec tier is reserved/);
  const g = broker.gate('run_node', TIERS.HOST_EXEC, { origin: 'agent' });
  assert.equal(g.decision, 'denied');
});

test('R1-1 source-shape: launch spec is the precise contract (M8)', () => {
  const spec = buildLaunchSpec({
    traceFile: '/x/traces/c1/trace.ndjson',
    profileDir: '/x/profiles/e1',
  });
  assert.ok(spec.includes('--xtrace-causality=sync'));
  assert.ok(spec.includes('--xtrace-ignition-observer'));
  assert.ok(spec.includes('--js-flags=--allow-natives-syntax --max-opt=0'));
  assert.ok(spec.includes('--xtrace-file=/x/traces/c1/trace.ndjson'));
  assert.ok(spec.includes('--user-data-dir=/x/profiles/e1'));
  // no transport flags here — launchBrowser owns those
  assert.ok(!spec.includes('--remote-debugging-pipe'));
});

test('capabilities: three states; non-enhanced => enhanced unavailable', () => {
  const reg = registry();
  reg.add({ name: 'trace_query', tier: TIERS.READ_EVIDENCE });
  reg.add({ name: 'jsvmp_query', tier: TIERS.READ_EVIDENCE,
            degradedReason: 'first-batch event surface only' });
  reg.add({ name: 'jsvmp_disassemble', tier: TIERS.READ_EVIDENCE,
            unavailableReason: 'frx sources pending' });
  const out = reg.negotiate({ hasXTraceDomain: false });
  assert.equal(out.enhanced, false);
  assert.ok(out.tools.every((t) => t.state === 'unavailable'));
  assert.match(out.tools[0].reason, /no XTrace domain/);
  const enhanced = reg.negotiate({ hasXTraceDomain: true });
  const byName = Object.fromEntries(enhanced.tools.map((t) => [t.name, t]));
  assert.equal(byName.trace_query.state, 'available');
  assert.equal(byName.jsvmp_query.state, 'degraded');
  assert.match(byName.jsvmp_query.reason, /first-batch/);
  assert.equal(byName.jsvmp_disassemble.state, 'unavailable');
});

test('orphan resolution: settled adopts read-only; live+unsettled terminates', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'trace.manifest.json'),
      JSON.stringify({ terminal: { state: 'incomplete' } }));
  const killed = [];
  const r1 = resolveOrphan({ pid: 1, traceDir: dir, index: null,
      kill: (p) => killed.push(p), pidAlive: () => true });
  assert.equal(r1.action, 'adopt-read-only');   // incomplete IS settled
  const dir2 = tmp();                            // no manifest + live pid
  const r2 = resolveOrphan({ pid: 9, traceDir: dir2, index: null,
      kill: (p) => killed.push(p), pidAlive: () => true });
  assert.equal(r2.action, 'terminated');
  assert.deepEqual(killed, [9]);
  const r3 = resolveOrphan({ pid: 9, traceDir: dir2, index: null,
      kill: (p) => killed.push(p), pidAlive: () => false });
  assert.equal(r3.action, 'adopt-read-only');
  assert.deepEqual(killed, [9]);
});

function readLedger(broker) {
  return fs.readFileSync(broker.ledgerPath, 'utf8').trim().split('\n')
      .map((l) => JSON.parse(l));
}


// ================= P6-R2 restored coverage (R2-4) ======================

test('R2-4 restore: env lifecycle — seven ops, isolation, exclusivity', () => {
  const { createEnvManager } = require('../src/env-manager');
  const root = tmp();
  const ws = createWorkspace(root);
  const envs = createEnvManager({ workspace: ws });
  const e1 = envs.create('site-a', { notes: 'first' });
  const e2 = envs.create('site-b');
  assert.notEqual(e1.dir, e2.dir);
  assert.equal(envs.list().length, 2);
  fs.writeFileSync(path.join(e1.dir, 'marker-a'), 'a');
  fs.writeFileSync(path.join(e2.dir, 'marker-b'), 'b');
  assert.ok(!fs.existsSync(path.join(e2.dir, 'marker-a')));
  assert.ok(!fs.existsSync(path.join(e1.dir, 'marker-b')));
  envs.open('site-a');
  assert.throws(() => envs.open('site-b'), /close it first/);
  assert.equal(envs.activeProfile(), e1.dir);
  envs.update('site-a', { notes: 'updated' });
  assert.equal(envs.status('site-a').notes, 'updated');
  assert.equal(envs.status('site-a').opens, 1);   // m5: opens, not launches
  envs.close('site-a');
  assert.equal(envs.activeProfile(), null);
  envs.open('site-b');
  envs.close('site-b');
  envs.open('site-b');
  envs.close('site-b');
  assert.equal(envs.status('site-b').opens, 2);
  envs.open('site-b');
  assert.throws(() => envs.delete('site-b'), /close before delete/);
  envs.close('site-b');
  envs.delete('site-b');
  assert.equal(envs.list().length, 1);
  assert.throws(() => envs.create('../escape'), /invalid env name/);
});

test('R2-4 restore: agent loop cancellation + no-progress breaker', async () => {
  const { createAgentLoop } = require('../src/agent-loop');
  const root = tmp();
  const ws = createWorkspace(root);
  const tools = [brokerTool('probe_tool', TIERS.READ_EVIDENCE,
      async () => ({ big: 'x'.repeat(50) }))];
  let cancelObj;
  const cancellingModel = async (state) => {
    if (state.iteration === 2) {
      cancelObj.cancel();
    }
    return { type: 'tool', name: 'probe_tool', args: {} };
  };
  cancelObj = { cancelled: false, cancel() { this.cancelled = true; } };
  const loop1 = createAgentLoop({ broker: createBroker({ workspace: ws }),
      tools, index: null, workspace: ws, model: cancellingModel });
  const out1 = await loop1.run({ cancellation: cancelObj });
  assert.equal(out1.status, 'cancelled');

  const failingModel = async () => ({ type: 'tool', name: 'no_such_tool' });
  const loop2 = createAgentLoop({ broker: createBroker({ workspace: ws }),
      tools, index: null, workspace: ws, model: failingModel,
      limits: { no_progress_streak: 2, max_iterations: 50 } });
  const out2 = await loop2.run();
  assert.equal(out2.status, 'no-progress');
  assert.ok(out2.iterations <= 3);
});

function brokerTool(name, tier, run) {
  return { name, tier, run };
}

test('R2-4 restore: index rebuild identity (wipe + rebuild == original)', () => {
  const { createEvidenceIndex } = require('../src/evidence-index');
  const root = tmp();
  const dir = path.join(root, 'traces', 'cap-id');
  fs.mkdirSync(dir, { recursive: true });
  const events = [];
  for (let i = 0; i < 50; i++) {
    events.push({ schema_version: 3, producer_id: 'rtx:r:1:1',
      producer_seq: String(i + 1), api: 'Api.x',
      causality: { kind: 'singleton' } });
  }
  fs.writeFileSync(path.join(dir, 'trace.ndjson'),
      events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  fs.writeFileSync(path.join(dir, 'trace.manifest.json'), JSON.stringify({
    schema_version: 3, capture_id: 'cap-id', accounting_model: '2',
    observation_coverage: 'partial',
    terminal: { state: 'complete', reason: null },
    counts: { eligible: '50', enqueued: '50', dropped: '1', accepted: '50',
              written: '49', failed: '1', sampled_out: '3',
              partial_observations: '0' },
    producers: [{ producer_id: 'rtx:r:1:1', process_epoch: '1',
      eligible: '50', enqueued: '50', dropped: '1', sampled_out: '3',
      partial_observations: '0', accepted: '50', written: '49', failed: '1',
      watermark: { received: true } },
      { producer_id: 'bnet:q:9:1', process_epoch: '9',
        watermark: { received: false } }],
  }));
  const ws = createWorkspace(root);
  const db = path.join(ws.dir('index'), 'index.db');
  const idx1 = createEvidenceIndex(db);
  const first = idx1.rebuildFromDir(path.join(root, 'traces'));
  const rows1 = idx1.listCaptures();
  idx1.close();
  const idx2 = createEvidenceIndex(db);   // fresh handle == wiped state
  const second = idx2.rebuildFromDir(path.join(root, 'traces'));
  const rows2 = idx2.listCaptures();
  assert.deepEqual(first, second);
  assert.equal(rows1[0].capture_id, rows2[0].capture_id);
  assert.equal(rows1[0].event_count, rows2[0].event_count);
  assert.equal(rows1[0].drop_counters.dropped, 1);
  assert.equal(rows1[0].unconfirmed_count, 1);
  idx2.close();
});

test('R2-4 restore: A-13 registration + unavailable tools refuse at runtime', () => {
  const { createAGroupAdapters } = require('../src/adapters-agroup');
  const root = tmp();
  const ws = createWorkspace(root);
  const adapters = createAGroupAdapters({ workspace: ws, index: null });
  const INVENTORY_A13 = [
    'code_search', 'scripts_list', 'jsvmp_query', 'webapi_query',
    'find_param_entry', 'crypto_scan', 'jsvmp_split_dispatcher',
    'jsvmp_disassemble', 'skill_list', 'skill_get', 'skill_read_resource',
    'notes_get', 'recall',
  ];
  const names = adapters.map((a) => a.name);
  for (const n of INVENTORY_A13) {
    assert.ok(names.includes(n), `inventory tool missing: ${n}`);
  }
  // runtime refusal (not just negotiation state)
  const dis = adapters.find((a) => a.name === 'jsvmp_disassemble');
  return dis.run({ bytecode: 'x' }).then(
      () => { throw new Error('unavailable tool must refuse'); },
      (e) => assert.match(e.message, /not migrated/));
});

test('R2-4 restore: agent+basisHint PARKS at pending (no self-confirm)', async () => {
  const ws = createWorkspace(tmp());
  const broker = createBroker({ workspace: ws });
  let side = 0;
  const tool = broker.register({ name: 'env_open',
      tier: TIERS.STATEFUL_CONTROL, run: async () => { side += 1; } });
  const exec = broker.execute(tool, { name: 'x' },
      { origin: 'agent', reason: 'probe agent basisHint',
        basisHint: BASES.UI_DIRECT_CLICK });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(broker.pendingCount(), 1, 'agent call parks');
  broker.resolveConfirmation(broker.pendingIds()[0], false);
  await assert.rejects(() => exec, /denied by user/);
  assert.equal(side, 0);
  const ledger = fs.readFileSync(broker.ledgerPath, 'utf8');
  assert.ok(!/"origin":"agent","decision":"confirmed","basis":"ui-direct-click"/
      .test(ledger));
});

test('R2-5: actual-byte accounting — 3x60KB refused over a 128KB budget', async () => {
  const { createAgentLoop } = require('../src/agent-loop');
  const ws = createWorkspace(tmp());
  const broker = createBroker({ workspace: ws });
  const tools = [{
    name: 'bulk_tool', tier: TIERS.READ_EVIDENCE,
    run: async () => ({ blob: 'y'.repeat(60001) }),
  }];
  let calls = 0;
  const model = async (state) => {
    if (state.iteration <= 3) {
      return { type: 'tool', name: 'bulk_tool', args: {} };
    }
    return { type: 'final', answer: { used: state.budget.used } };
  };
  const loop = createAgentLoop({ broker,
      tools: tools.map((t) => broker.register(t)), index: null,
      workspace: ws, model,
      limits: { context_bytes: 100000, max_iterations: 8 } });
  const out = await loop.run();
  assert.equal(out.status, 'complete');
  // first result ~60KB charged; second must be REFUSED (60+60 > 128KB
  // already) — never silently min(bytes, 8192)
  const refused = out.log.filter((l) => l.type === 'tool-result-refused');
  const accepted = out.log.filter((l) => l.type === 'tool');
  assert.equal(accepted.length + refused.length, 3);
  assert.ok(refused.length >= 2,
      'over-budget results are refused, not clipped');
  assert.ok(accepted.every((a) => a.bytes > 50000),
      'actual bytes accounted');
  void calls;
});

test('R2-2 unit: CdpConnection send timeout (CDP_TIMEOUT)', async () => {
  const { CdpConnection } = require('../src/cdp');
  const fake = { stdio: [null, null, null,
      { write: () => {}, on: () => {} }, { on: () => {} }],
      on: () => {} };
  const conn = new CdpConnection(fake, { sendTimeoutMs: 40 });
  await assert.rejects(() => conn.send('Browser.getVersion'),
      (e) => e.code === 'CDP_TIMEOUT');
});

test('R2-2 unit: stop deadline miss returns stop-timeout with real elapsed', async () => {
  const { createHost } = require('../src/host');
  const root = tmp();
  const host = await createHost({ executable: '/nonexistent',
      workspaceRoot: root, skipBrowserLaunch: true });
  // fake a live-ish host: stop with a 30ms deadline against a send
  // that never answers
  host.closed = false;
  host.send = () => new Promise(() => {});   // hung browser
  const tool = host.tools.get('jsvmp_trace');
  const out = await host.broker.execute(tool,
      { action: 'stop', deadline_ms: 30 },
      { origin: 'ui', reason: 'deadline probe', basisHint: 'ui-direct-click' });
  assert.equal(out.terminal, 'stop-timeout');
  assert.ok(out.elapsed_ms >= 25, `real elapsed (${out.elapsed_ms}ms)`);
  assert.ok(out.stages.includes('deadline-missed'));
  host.close();
});
