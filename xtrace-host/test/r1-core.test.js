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
