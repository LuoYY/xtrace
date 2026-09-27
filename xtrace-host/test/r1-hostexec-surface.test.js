'use strict';
// M3-R1-5 gates: the host-exec product surface — the pending queue
// carries the action payload; running executions are listable (so
// cancelExecution is routable); the child env is allowlisted (a
// planted secret never reaches the child); timeout_ms is capped;
// writeRoots compare realpath-to-realpath (a symlinked write inside a
// policy root is judged consistently with the workspace gate).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { spawn } = require('node:child_process');
const { createBroker, TIERS, BASES } = require('../src/broker');
const { createWorkspace } = require('../src/workspace');
const { createExecutors } = require('../src/executors');

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'm3-r15-'));
}
function policyBroker(ws, writeRoots) {
  return createBroker({ workspace: ws, policy: { hostExecPolicy: {
    paths: { read: [], write: writeRoots || [] },
    network: { allow: [] }, deps: { npm: [] } } } });
}
function approve(broker) {
  const id = broker.pendingIds()[0];
  broker.resolveConfirmation(id, true);
}

test('R1-5: pendingList carries the action payload (PD1 surface)', async () => {
  const ws = createWorkspace(tmp());
  const broker = policyBroker(ws);
  const [runNode] = createExecutors({ workspace: ws });
  const tool = broker.register(runNode);
  const exec = broker.execute(tool,
      { __action: { argv: ['-e', '1'] } },
      { origin: 'agent', reason: 'payload surface probe' });
  await new Promise((r) => setTimeout(r, 5));
  const pending = broker.pendingList();
  assert.equal(pending.length, 1);
  assert.ok(pending[0].action, 'action payload in the pending row');
  assert.deepEqual(pending[0].action.argv, ['-e', '1']);
  broker.resolveConfirmation(pending[0].id, false);
  await assert.rejects(() => exec, /denied by user/);
});

test('R1-5: runningExecutions lists live children (cancel routable)', async () => {
  const ws = createWorkspace(tmp());
  const broker = policyBroker(ws);
  const executors = createExecutors({ workspace: ws });
  const runPython = executors.find((t) => t.name === 'run_python');
  const tool = broker.register(runPython);
  let cid = null;
  const context = { origin: 'agent', reason: 'running list probe',
    onConfirmation: (id) => { cid = id; } };
  const exec = broker.execute(tool, {
    __action: { argv: ['-c', 'import time;time.sleep(30)'] },
    timeout_ms: 60000,
  }, context);
  await new Promise((r) => setTimeout(r, 5));
  approve(broker);
  await new Promise((r) => setTimeout(r, 700));
  const running = broker.runningExecutions();
  assert.equal(running.length, 1);
  assert.equal(running[0].id, cid);
  assert.equal(running[0].kill_registered, true);
  broker.cancelExecution(cid);
  const out = await exec;
  assert.equal(out.cancelled, true);
});

test('R1-5: child env is allowlisted — a planted secret never leaks', async () => {
  const ws = createWorkspace(tmp());
  const broker = policyBroker(ws);
  process.env.M3R5_SECRET = 'TOPSECRET';
  try {
    const [runNode] = createExecutors({ workspace: ws });
    const tool = broker.register(runNode);
    const exec = broker.execute(tool, {
      __action: { argv: ['-e',
        'process.stdout.write(process.env.M3R5_SECRET || "NOT-PRESENT")'] },
    }, { origin: 'agent', reason: 'env leak probe' });
    await new Promise((r) => setTimeout(r, 5));
    approve(broker);
    const out = await exec;
    assert.equal(out.exit_code, 0);
    assert.ok(out.output.includes('NOT-PRESENT'),
        'the allowlist dropped the secret');
    // the whitelist basics survive
    const exec2 = broker.execute(tool, {
      __action: { argv: ['-e',
        'process.stdout.write(Boolean(process.env.PATH) ? "HAS-PATH" : ' +
        '"NO-PATH")'] },
    }, { origin: 'agent', reason: 'env whitelist basics' });
    await new Promise((r) => setTimeout(r, 5));
    approve(broker);
    const out2 = await exec2;
    assert.ok(out2.output.includes('HAS-PATH'));
  } finally {
    delete process.env.M3R5_SECRET;
  }
});

test('R1-5: timeout_ms is capped (watchdog cannot be disabled)', async () => {
  const ws = createWorkspace(tmp());
  const broker = policyBroker(ws);
  const [runNode] = createExecutors({ workspace: ws });
  const tool = broker.register(runNode);
  const exec = broker.execute(tool, {
    __action: { argv: ['-e', 'setTimeout(()=>{},3600000)'] },
    timeout_ms: 36000000,   // caller tries 10 hours
  }, { origin: 'agent', reason: 'timeout cap probe' });
  await new Promise((r) => setTimeout(r, 5));
  approve(broker);
  const started = Date.now();
  const out = await exec;
  assert.equal(out.timed_out, true);
  assert.ok(Date.now() - started < 150000,
      'the cap held (MAX_TIMEOUT_MS=120s)');
});

test('R1-5: writeRoots compare realpath-to-realpath (symlink judged consistently)', () => {
  const ws = createWorkspace(tmp());
  const real = path.join(ws.root, 'allowed-real');
  fs.mkdirSync(real, { recursive: true });
  const link = path.join(ws.root, 'allowed-link');
  fs.symlinkSync(real, link);
  const broker = policyBroker(ws, [link]);   // policy names the LINK
  // a write through the REAL dir must be allowed (realpath equal) —
  // the old unresolved prefix would have denied it while naming link
  const g = broker.gate('run_node', TIERS.HOST_EXEC, {
    origin: 'agent', reason: 'realpath root probe',
    action: { argv: ['x'], writePath: path.join(real, 'f.txt') },
  });
  assert.equal(g.decision, 'confirmation-required',
      'realpath comparison accepts the real dir under a link root');
  const broker2 = policyBroker(ws, [link]);
  const g2 = broker2.gate('run_node', TIERS.HOST_EXEC, {
    origin: 'agent', reason: 'outside probe',
    action: { argv: ['x'], writePath: '/tmp/definitely-outside.txt' },
  });
  assert.equal(g2.decision, 'denied');
  assert.match(g2.reason, /write-outside-policy/);
});
