'use strict';
// M3-E1 gates (PD1 anchors): host-exec tier.
//   default-deny     no policy object -> registration + execution denied
//   policy-hits      run_node executes, audit carries FULL argv /
//                    exit_code / output_bytes; output truncated at cap
//   timeout-kills    a sleeping child is SIGKILLed, timed_out=true
//   cancel-kills     Broker-mediated cancellation: the child pid
//                    DISAPPEARS (verified alive->dead) and the audit
//                    records cancelled=true
//   network-miss     an argv URL whose host is outside network.allow
//                    denies with the exact miss recorded
//   write-outside    a writePath outside paths.write denies
//   too-wide         network.allow:['*'] trips the guard (negative
//                    control from the acceptance anchors)
//   payload-missing  no __action -> denied (never an unaudited run)
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createBroker, TIERS, BASES } = require('../src/broker');
const { createWorkspace } = require('../src/workspace');
const { createExecutors } = require('../src/executors');

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'm3-e1-'));
}
function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
function readLedger(broker) {
  return fs.readFileSync(broker.ledgerPath, 'utf8').trim().split('\n')
      .map((l) => JSON.parse(l));
}

function policyBroker(ws, overrides) {
  return createBroker({ workspace: ws, policy: {
    hostExecPolicy: {
      paths: { read: [], write: [path.join(ws.root, 'out')] },
      network: { allow: ['registry.npmjs.org'] },
      deps: { npm: [] },
      ...overrides,
    },
  } });
}

function approvePending(broker) {
  const id = broker.pendingIds()[0];
  assert.ok(id, 'a pending entry exists');
  broker.resolveConfirmation(id, true);   // human-approved
}

test('E1: default-deny without a policy object', async () => {
  const ws = createWorkspace(tmp());
  const broker = createBroker({ workspace: ws });   // NO policy
  const [runNode] = createExecutors({ workspace: ws });
  assert.throws(() => broker.register(runNode),
      /host-exec tier requires a policy object/);
  const g = broker.gate('run_node', TIERS.HOST_EXEC,
      { origin: 'agent', reason: 'probe', action: { argv: ['-e', '1'] } });
  assert.equal(g.decision, 'denied');
  assert.match(g.reason, /no policy object|tier disabled/);
  const ledger = readLedger(broker);
  assert.ok(ledger.some((r) => r.policy_verdict ===
      'no-policy:tier-default-deny'));
});

test('E1: policy hit executes; audit carries argv/exit/output; capped', async () => {
  const ws = createWorkspace(tmp());
  const broker = policyBroker(ws);
  const [runNode] = createExecutors({ workspace: ws });
  const tool = broker.register(runNode);
  const action = { argv: ['-e', 'process.stdout.write("x".repeat(100000))'] };
  const exec = broker.execute(tool,
      { __action: action, max_output_bytes: 4096 },
      { origin: 'agent', reason: 'bounded output probe' });
  await new Promise((r) => setTimeout(r, 5));
  approvePending(broker);
  const out = await exec;
  assert.equal(out.exit_code, 0);
  assert.equal(out.output.length, 4096);
  assert.equal(out.truncated, true);
  assert.ok(out.output_bytes >= 100000);
  const executed = readLedger(broker).filter((r) =>
      r.decision === 'executed');
  assert.ok(executed.length >= 1);
  assert.match(executed[0].argv, /-e process.stdout.write/);
  assert.equal(executed[0].exit_code, 0);
  assert.ok(executed[0].output_bytes >= 100000);
  const confirmed = readLedger(broker).find((r) =>
      r.decision === 'confirmed');
  assert.equal(confirmed.basis, BASES.HUMAN_APPROVED);
});

test('E1: timeout kills the child; timed_out audited', async () => {
  const ws = createWorkspace(tmp());
  const broker = policyBroker(ws);
  const [runNode] = createExecutors({ workspace: ws });
  const tool = broker.register(runNode);
  const exec = broker.execute(tool, {
    __action: { argv: ['-e', 'setTimeout(()=>{}, 60000)'] },
    timeout_ms: 300,
  }, { origin: 'agent', reason: 'timeout probe' });
  await new Promise((r) => setTimeout(r, 5));
  approvePending(broker);
  const out = await exec;
  assert.equal(out.timed_out, true);
  assert.equal(out.exit_code, null);
  const executed = readLedger(broker).find((r) =>
      r.decision === 'executed' && r.tool === 'run_node');
  assert.equal(executed.timed_out, true);
});

test('E1: Broker cancel kills the RUNNING child (pid dies, audited)', async () => {
  const ws = createWorkspace(tmp());
  const broker = policyBroker(ws);
  const executors = createExecutors({ workspace: ws });
  const runPython = executors.find((t) => t.name === 'run_python');
  const tool = broker.register(runPython);
  // capture the confirmation id via the broker's observer callback,
  // then APPROVE so the child actually spawns, then cancelExecution
  let confirmationId = null;
  const context = {
    origin: 'agent', reason: 'cancel probe',
    onConfirmation: (id) => { confirmationId = id; },
  };
  const exec = broker.execute(tool, {
    __action: { argv: ['-c',
        'import sys,time;sys.stdout.write("ALIVE\\n");sys.stdout.flush();'
        + 'time.sleep(60)'] },
    timeout_ms: 60000,
  }, context);
  await new Promise((r) => setTimeout(r, 5));
  const id = broker.pendingIds()[0];
  assert.ok(id, 'parked at pending before the human answers');
  broker.resolveConfirmation(id, true);          // human-approved
  await new Promise((r) => setTimeout(r, 700));  // child spawns + sleeps
  assert.ok(confirmationId, 'confirmation id captured');
  const cancelled = broker.cancelExecution(confirmationId);
  assert.equal(cancelled, true, 'kill handle fired');
  const out = await exec;
  assert.equal(out.cancelled, true);
  assert.ok(out.pid > 0);
  // SIGKILL delivery is asynchronous in the OS — give it a moment
  let dead = false;
  for (let i = 0; i < 40 && !dead; i++) {
    dead = !pidAlive(out.pid);
    if (!dead) {
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  assert.ok(dead, 'child process is really dead');
  const rows = readLedger(broker);
  assert.ok(rows.some((r) => r.decision === 'execution-cancelled' &&
      r.confirmation_id === confirmationId));
  assert.ok(rows.some((r) => r.decision === 'executed' &&
      r.cancelled === true));
});

test('E1: network-miss and write-outside deny with exact verdicts', () => {
  const ws = createWorkspace(tmp());
  const broker = policyBroker(ws);
  const net = broker.gate('run_node', TIERS.HOST_EXEC, {
    origin: 'agent', reason: 'net probe',
    action: { argv: ['https://evil.example.com/x'] },
  });
  assert.equal(net.decision, 'denied');
  assert.match(net.reason, /network-miss:evil\.example\.com/);
  const write = broker.gate('run_node', TIERS.HOST_EXEC, {
    origin: 'agent', reason: 'write probe',
    action: { argv: ['script.js'], writePath: '/tmp/outside.js' },
  });
  assert.equal(write.decision, 'denied');
  assert.match(write.reason, /write-outside-policy:\/tmp\/outside\.js/);
  const ledger = readLedger(broker);
  assert.ok(ledger.some((r) => String(r.policy_verdict)
      .includes('network-miss:evil.example.com')));
  assert.ok(ledger.some((r) => String(r.policy_verdict)
      .includes('write-outside-policy')));
});

test('E1 negative control: network.allow:["*"] trips the too-wide guard', () => {
  const ws = createWorkspace(tmp());
  const broker = policyBroker(ws, { network: { allow: ['*'] } });
  const g = broker.gate('run_node', TIERS.HOST_EXEC, {
    origin: 'agent', reason: 'wide probe',
    action: { argv: ['-e', '1'] },
  });
  assert.equal(g.decision, 'denied');
  assert.match(g.reason, /policy too wide/);
  const ledger = readLedger(broker);
  assert.ok(ledger.some((r) => r.policy_verdict ===
      'policy-too-wide:network.allow contains *'));
});

test('E1: no action payload -> denied, never an unaudited run', () => {
  const ws = createWorkspace(tmp());
  const broker = policyBroker(ws);
  const g = broker.gate('run_node', TIERS.HOST_EXEC, {
    origin: 'agent', reason: 'payload probe',
  });
  assert.equal(g.decision, 'denied');
  assert.match(g.reason, /concrete action payload/);
  assert.ok(!broker.pendingCount(), 'nothing parked');
});
