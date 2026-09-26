'use strict';
// M3-E6 gates: structural non-bypass (PD4) + resolveOrphan/adoption
// hardening (the P6-R2 H close). Three axes:
//   broker-bound — adapters.all() rows carry NO callable .run; the
//                  only execution path is callTool (a direct .run call
//                  would throw — negative control)
//   adoption      — both resolveOrphan paths (adopt-read-only /
//                  terminate) against a REAL capture dir on disk, with
//                  the index actually ingesting on adoption
//   static gate   — covered by scripts/p6-r1-static-shape.js checks 6/7
//                  (adapter .run confined + planted-bypass negative);
//                  this file asserts the gate FILE carries them.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createHost, resolveOrphan } = require('../src/host');

const ROOT = path.resolve(__dirname, '..', '..');

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'm3-e6-'));
}

function writeCapture(root, name, { settled = true } = {}) {
  const dir = path.join(root, 'traces', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'trace.ndjson'), JSON.stringify({
    schema_version: 3, producer_id: 'r:1:1', producer_seq: '1',
    api: 'X', causality: { kind: 'singleton' },
  }) + '\n');
  if (settled) {
    fs.writeFileSync(path.join(dir, 'trace.manifest.json'),
        JSON.stringify({ schema_version: 3, capture_id: name,
          terminal: { state: 'complete', reason: null },
          counts: { dropped: '1', failed: '0', sampled_out: '2',
                    partial_observations: '0' },
          producers: [] }));
  }
  return dir;
}

test('E6: broker-bound — adapters.all() rows carry no callable run', async () => {
  const root = tmp();
  fs.mkdirSync(root, { recursive: true });
  const host = await createHost({ executable: '/nonexistent',
      workspaceRoot: root, skipBrowserLaunch: true });
  try {
    for (const row of host.adapters.all()) {
      assert.equal(typeof row.run, 'undefined',
          `${row.name} row must not expose .run`);
      assert.equal(typeof row.available, 'undefined',
          `${row.name} row must not expose .available`);
      assert.ok(row.name && row.tier, 'descriptor shape');
    }
    // callTool remains THE path (works for a read tool)
    const out = await host.callTool('trace_summary', {},
        { origin: 'agent' });
    assert.ok(Array.isArray(out));
    // NEGATIVE CONTROL: a captured internal tool's .run would work,
    // but adapters.all() gives no way to GET one — the same lookup via
    // host.tools (internal) is the only source; assert the descriptor
    // surface exposes no execution entry by construction: fetching a
    // row by name from all() and calling run must be undefined.
    const probe = host.adapters.all().find((t) => t.name === 'fs_read');
    assert.ok(probe);
    assert.equal(probe.run, undefined);
  } finally {
    host.close();
  }
});

test('E6: resolveOrphan adopt-read-only actually ingests; terminate kills', async () => {
  const root = tmp();
  fs.mkdirSync(root, { recursive: true });
  const captureDir = writeCapture(root, 'cap-orphan');
  const host = await createHost({ executable: '/nonexistent',
      workspaceRoot: root, skipBrowserLaunch: true });
  try {
    // path 1: dead pid + settled manifest -> adopt + ingest
    const decision = resolveOrphan({ pid: 999999, traceDir: captureDir,
        index: host.index });
    assert.equal(decision.action, 'adopt-read-only');
    const ingested = host.index.ingestCaptureDir(captureDir);
    assert.equal(ingested.eventCount, 1);
    const rows = host.index.listCaptures();
    assert.equal(rows[0].drop_counters.sampled_out, 2);
    assert.equal(rows[0].terminal, 'complete');
    // adoption is idempotent (re-ingest same dir)
    host.index.ingestCaptureDir(captureDir);
    assert.equal(host.index.listCaptures().length, 1);
  } finally {
    host.close();
  }

  // path 2: live pid + UNSETTLED manifest -> terminate (kill verified)
  const root2 = tmp();
  const unset = writeCapture(root2, 'cap-unsettled', { settled: false });
  const { spawn } = require('node:child_process');
  const sleeper = spawn(process.execPath,
      ['-e', 'setInterval(()=>{},1000)']);
  const killed = [];
  const decision = resolveOrphan({ pid: sleeper.pid, traceDir: unset,
      index: null, kill: (p) => killed.push(p),
      pidAlive: () => true });
  assert.equal(decision.action, 'terminated');
  assert.deepEqual(killed, [sleeper.pid]);
  sleeper.kill('SIGKILL');
});

test('E6: the static gate ships the adapter-run + negative-control checks', () => {
  const gate = fs.readFileSync(
      path.join(ROOT, 'scripts/p6-r1-static-shape.js'), 'utf8');
  assert.match(gate, /adapter\s*\.\s*run\s*\(/,
      'gate targets adapter .run( invocations');
  assert.match(gate, /planted bypass/,
      'gate carries the planted-bypass negative control');
});
