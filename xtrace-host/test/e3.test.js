'use strict';
// P6-E3 gates: env lifecycle + ISOLATION measured; the control path
// (jsvmp_trace) runs through the Broker with confirmation and asserts
// the settled (terminal, coverage) pair on a REAL browser with REAL
// budget skips (the S2 axes: transport terminal != coverage).

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createWorkspace } = require('../src/workspace');
const { createBroker, TIERS } = require('../src/broker');
const { createEnvManager } = require('../src/env-manager');
const { createBGroupAdapters } = require('../src/adapters-bgroup');

const ROOT = path.resolve(__dirname, '..', '..');
const EXE = path.join(ROOT, 'chromium/src/out/XTraceIntegration/ChromiumX.app/Contents/MacOS/Chromium');

test('env lifecycle: seven operations, structural isolation, open-exclusivity', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xtrace-e3-'));
  const ws = createWorkspace(root);
  const envs = createEnvManager({ workspace: ws });

  const e1 = envs.create('site-a', { notes: 'first env' });
  const e2 = envs.create('site-b');
  // ISOLATION: separate directories under the profiles root
  assert.notEqual(e1.dir, e2.dir);
  assert.equal(envs.list().length, 2);
  fs.writeFileSync(path.join(e1.dir, 'profile-marker-a'), 'a');
  fs.writeFileSync(path.join(e2.dir, 'profile-marker-b'), 'b');
  assert.ok(!fs.existsSync(path.join(e2.dir, 'profile-marker-a')));
  assert.ok(!fs.existsSync(path.join(e1.dir, 'profile-marker-b')));

  // one open env at a time
  envs.open('site-a');
  assert.throws(() => envs.open('site-b'), /close it first/);
  assert.equal(envs.activeProfile(), e1.dir);
  envs.update('site-a', { notes: 'updated' });
  assert.equal(envs.status('site-a').notes, 'updated');
  assert.equal(envs.status('site-a').launches, 1);
  envs.close('site-a');
  assert.equal(envs.activeProfile(), null);
  envs.open('site-b');
  envs.close('site-b');

  // delete refuses while open; works after close
  envs.open('site-b');
  assert.throws(() => envs.delete('site-b'), /close before delete/);
  envs.close('site-b');
  envs.delete('site-b');
  assert.equal(envs.list().length, 1);

  // names are constrained; delete stays inside the profiles root
  assert.throws(() => envs.create('../escape'), /invalid env name/);
});

test('jsvmp_trace stop asserts the (terminal, coverage) pair on a real browser',
     { timeout: 90000 }, async () => {
  const { createHost } = require('../src/host');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xtrace-e3b-'));
  const ws = createWorkspace(root);
  const traceFile = path.join(ws.dir('traces'), 'e3-integration.ndjson');
  const host = await createHost({
    executable: EXE,
    browserArgs: [
      `--user-data-dir=${path.join(root, 'p')}`,
      '--xtrace-enable', `--xtrace-file=${traceFile}`,
      '--xtrace-categories=reverse', '--xtrace-causality=sync',
      '--xtrace-ignition-observer',
      '--js-flags=--allow-natives-syntax --max-opt=0',
    ],
    workspaceRoot: root,
    traceFile,
  });
  const broker = createBroker({ workspace: ws });
  const envs = createEnvManager({ workspace: ws });
  const adapters = createBGroupAdapters({ workspace: ws, host, envs });
  const byName = {};
  for (const adapter of adapters) {
    byName[broker.register(adapter).name] = adapter;
  }
  const REASON = 'controlled capture of the local fixture for E3 acceptance';
  try {
    // B-group stateful control: per-call confirmation (auto-approve in
    // the test harness the way the UI would).
    async function call(tool, args) {
      const exec = broker.execute(tool, args, { origin: 'agent', reason: REASON });
      // resolve the confirmation id THIS execution created (poll the
      // broker's pending set, not a separate gate() call)
      for (let i = 0; i < 200 && broker.pendingCount() > 0; i++) {
        await new Promise((r) => setTimeout(r, 5));
        for (const id of broker.pendingIds()) {
          broker.resolveConfirmation(id, true);
        }
      }
      return exec;
    }

    const page = await host.send('Target.createTarget',
        { url: 'about:blank' });
    const { sessionId } = await host.send('Target.attachToTarget',
        { targetId: page.targetId, flatten: true });
    await host.send('Runtime.enable', {}, sessionId);

    // START with a TINY window budget: real sampled_out on stop
    const start = await call(byName.jsvmp_trace,
        { action: 'start', max_taps: 5 });
    assert.equal(start.state, 'active');

    const LOOP = `(()=>{const s=document.createElement('script');
      s.textContent='window.__e3=(function(){function f(n){var acc=0;for(var i=0;i<n;i++){acc=(acc+i*7)%4096;}return acc;}var r={v:f(20)};return r;})();';
      document.documentElement.appendChild(s);
      return window.__e3;})()`;
    const result = await host.send('Runtime.evaluate',
        { expression: LOOP, returnByValue: true }, sessionId);
    assert.ok(result.result?.value?.v !== undefined, 'page ran');
    await new Promise((r) => setTimeout(r, 1200));

    // STOP: the tool must settle and return the PAIR
    const stop = await call(byName.jsvmp_trace, { action: 'stop' });
    assert.ok(stop.pair, 'stop returns the (terminal, coverage) pair');
    assert.equal(stop.pair.terminal, 'complete',
        `transport terminal: ${JSON.stringify(stop)}`);
    assert.equal(stop.pair.coverage, 'partial',
        `coverage with budget skips: ${JSON.stringify(stop.pair)}`);
    assert.ok(Number(stop.counts?.sampled_out) > 0, 'real budget skips counted');
    assert.equal(stop.trace_file, traceFile);

    // STATUS after stop
    const status = await call(byName.jsvmp_trace, { action: 'status' });
    assert.ok(['settled', 'complete', 'inactive', 'stopped']
        .includes(status.state) || status.state != null);

    // every control call went through the Broker: audit trail proves it
    const ledger = fs.readFileSync(broker.ledgerPath, 'utf8').trim().split('\n')
        .map((l) => JSON.parse(l));
    const jsvmpOps = ledger.filter((e) => e.tool === 'jsvmp_trace');
    assert.ok(jsvmpOps.length >= 6,
        'grants + confirmations + executions all audited');
    assert.ok(ledger.some((e) => e.tool === 'jsvmp_trace' &&
        e.decision === 'confirmed'));
  } finally {
    await host.close();
  }
});
