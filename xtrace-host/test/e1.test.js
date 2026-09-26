'use strict';
// P6-E1 gates: untrusted-path rejection MEASURED; Broker single-entry
// (Agent/UI/MCP same path); three-tier decisions audited; capability
// negotiation three states; no-reconnect ownership.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createWorkspace } = require('../src/workspace');
const { createBroker, TIERS } = require('../src/broker');
const { negotiate, registry } = require('../src/capabilities');
const { resolveOrphan } = require('../src/host');

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'xtrace-host-'));
}

test('workspace rejects symlink escapes by realpath (untrusted path)', () => {
  const root = tmp();
  const ws = createWorkspace(root);
  const outside = tmp();
  const escape = path.join(ws.dir('traces'), 'escape');
  fs.symlinkSync(outside, escape);
  // the string prefix LOOKS inside; realpath resolution says otherwise
  assert.ok(!ws.contains(escape));
  assert.throws(() => ws.assertInside(escape, 'trace'),
      /escapes the workspace boundary/);
  // a legitimate nested path is inside
  const ok = path.join(ws.dir('traces'), 'cap1', 'trace.ndjson');
  assert.ok(ws.contains(ok));
  ws.assertInside(ok);
});

test('broker: every caller origin goes through the same gate (single entry)', async () => {
  const ws = createWorkspace(tmp());
  const broker = createBroker({ workspace: ws });
  let ran = 0;
  const tool = broker.register({
    name: 'trace_query', tier: TIERS.READ_EVIDENCE,
    run: async () => { ran += 1; return { rows: [] }; },
  });
  // Agent loop, UI and MCP are just origins — one path.
  for (const origin of ['agent', 'ui', 'mcp']) {
    const out = await broker.execute(tool, {}, { origin });
    assert.deepEqual(out, { rows: [] });
  }
  assert.equal(ran, 3);
  const ledger = fs.readFileSync(broker.ledgerPath, 'utf8').trim().split('\n')
      .map((line) => JSON.parse(line));
  const origins = ledger.filter((e) => e.decision === 'granted')
      .map((e) => e.origin).sort();
  assert.deepEqual(origins, ['agent', 'mcp', 'ui']);
});

test('broker: stateful control requires a reason and a user confirmation', async () => {
  const ws = createWorkspace(tmp());
  const broker = createBroker({ workspace: ws });
  const tool = broker.register({
    name: 'jsvmp_trace.start', tier: TIERS.STATEFUL_CONTROL,
    run: async () => ({ started: true }),
  });
  await assert.rejects(() => broker.execute(tool, {}, { origin: 'agent' }),
      /reason string/);
  // gate() returns a confirmation request, not a grant
  const g = broker.gate('jsvmp_trace.start', TIERS.STATEFUL_CONTROL,
      { origin: 'ui', reason: 'begin controlled capture of local fixture' });
  assert.equal(g.decision, 'confirmation-required');
  // simulate the UI approving asynchronously
  const execution = broker.execute(tool, {},
      { origin: 'ui', reason: 'begin controlled capture of local fixture' });
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(broker.pendingCount(), 1);
  assert.ok(broker.resolveConfirmation(g.id, true));
  assert.deepEqual(await execution, { started: true });
  // denial path
  const g2 = broker.gate('jsvmp_trace.start', TIERS.STATEFUL_CONTROL,
      { origin: 'mcp', reason: 'second attempt' });
  const denied = broker.execute(tool, {}, { origin: 'mcp', reason: 'second attempt' });
  await new Promise((r) => setTimeout(r, 5));
  broker.resolveConfirmation(g2.id, false);
  await assert.rejects(() => denied, /denied by user/);
});

test('broker: host-exec tier is default-deny and not registrable in P6', () => {
  const ws = createWorkspace(tmp());
  const broker = createBroker({ workspace: ws });
  assert.throws(() => broker.register({
    name: 'run_node', tier: TIERS.HOST_EXEC, run: async () => {} }),
      /host-exec tier is reserved/);
  const g = broker.gate('run_node', TIERS.HOST_EXEC, { origin: 'agent' });
  assert.equal(g.decision, 'denied');
});

test('capabilities: non-enhanced browser => enhanced tools unavailable with reason', () => {
  const reg = registry();
  reg.add({ name: 'trace_query', tier: TIERS.READ_EVIDENCE });
  reg.add({ name: 'jsvmp_query', tier: TIERS.READ_EVIDENCE,
            degradedReason: 'first-batch event surface only (Ignition pre-events)' });
  const out = reg.negotiate({ hasXTraceDomain: false });
  assert.equal(out.enhanced, false);
  assert.ok(out.tools.every((t) => t.state === 'unavailable'));
  assert.match(out.tools[0].reason, /no XTrace domain/);
  const enhanced = reg.negotiate({ hasXTraceDomain: true });
  const byName = Object.fromEntries(enhanced.tools.map((t) => [t.name, t]));
  assert.equal(byName.trace_query.state, 'available');
  assert.equal(byName.jsvmp_query.state, 'degraded');
  assert.match(byName.jsvmp_query.reason, /first-batch event surface/);
});

test('orphan resolution: settled manifest adopts read-only; live+unsettled terminates', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'trace.manifest.json'),
      JSON.stringify({ terminal: { state: 'complete' } }));
  const killed = [];
  const r1 = resolveOrphan({ pid: 4242, traceDir: dir,
      kill: (p) => killed.push(p), pidAlive: () => true });
  assert.equal(r1.action, 'adopt-read-only');
  assert.deepEqual(killed, []);
  fs.writeFileSync(path.join(dir, 'trace.manifest.json'),
      JSON.stringify({ terminal: { state: 'incomplete' } }));
  // incomplete is still SETTLED (a terminal exists) — adoption, not kill
  const r2 = resolveOrphan({ pid: 4242, traceDir: dir,
      kill: (p) => killed.push(p), pidAlive: () => true });
  assert.equal(r2.action, 'adopt-read-only');
  const dir2 = tmp(); // no manifest at all + live pid => terminate
  const r3 = resolveOrphan({ pid: 999, traceDir: dir2,
      kill: (p) => killed.push(p), pidAlive: () => true });
  assert.equal(r3.action, 'terminated');
  assert.deepEqual(killed, [999]);
  const r4 = resolveOrphan({ pid: 1, traceDir: dir2,
      kill: (p) => killed.push(p), pidAlive: () => false });
  assert.equal(r4.action, 'adopt-read-only');
  assert.deepEqual(killed, [999]);
});
