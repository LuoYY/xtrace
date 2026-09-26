'use strict';
// P6-R1 GUI evidence gates: the thin helpers (B5 counters under a
// NON-default trace filename via the composition-root index), plus the
// renderer renderers for the new panel surfaces.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
// R2-1: the enrichment helper is GONE — the index rows carry the
// fields natively; this test asserts them directly.
const panel = require('../src/renderer/evidencePanel');
const { createHost } = require('../../xtrace-host/src/host');

function writeCapture(root, name, { traceName = 'trace-on.ndjson',
                                     dropped = 7, failed = 3,
                                     sampled = 11, partial = 5,
                                     unconfirmed = true }) {
  const dir = path.join(root, 'traces', name);
  fs.mkdirSync(dir, { recursive: true });
  const events = [
    {schema_version: 3, producer_id: 'rtx:a:1:1', process_epoch: '1',
     producer_seq: '1', writer_seq: '1', config_generation: '1',
     mono_time_us: '1', wall_time_us: '1', pid: 1, tid: 1,
     category: 'reverse', phase: 'call', api: 'Document.cookie.set',
     args: [], stack: [], attribution: {status: 'unresolved'},
     causality: {kind: 'paired', call_id: 's:1', parent_id: null,
                 depth: 0, duration_us: null}},
    {schema_version: 3, producer_id: 'bnet:z:9:1', process_epoch: '9',
     producer_seq: '1', writer_seq: '1', config_generation: '1',
     mono_time_us: '2', wall_time_us: '2', pid: 2, tid: 2,
     category: 'reverse', phase: 'call', api: 'BrowserNetwork.response',
     args: [], stack: [], attribution: {status: 'unresolved'},
     causality: {kind: 'external', call_id: null, parent_id: null,
                 depth: 0, duration_us: null}},
  ];
  fs.writeFileSync(path.join(dir, traceName),
      events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  fs.writeFileSync(path.join(dir,
      traceName.replace(/\.ndjson$/, '.manifest.json')), JSON.stringify({
    schema_version: 3, capture_id: name, accounting_model: '2',
    observation_coverage: 'partial',
    terminal: { state: 'complete', reason: null },
    counts: { eligible: '9', enqueued: '9', dropped: String(dropped),
              accepted: '9', written: '6', failed: String(failed),
              sampled_out: String(sampled),
              partial_observations: String(partial) },
    producers: [
      { producer_id: 'rtx:a:1:1', process_epoch: '1', eligible: '9',
        enqueued: '9', dropped: String(dropped),
        sampled_out: String(sampled),
        partial_observations: String(partial), accepted: '9',
        written: '6', failed: String(failed),
        watermark: { received: true } },
      ...(unconfirmed ? [{ producer_id: 'bnet:z:9:1', process_epoch: '9',
          eligible: null, enqueued: null, dropped: null,
          watermark: { received: false } }] : []),
    ],
  }));
  return dir;
}

test('B5 gate: trace-on naming — counters equal disk truth via the composition root', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'r1-gui-b5-'));
  const dir = writeCapture(root, 'cap-b5', {});
  const host = await createHost({ executable: '/nonexistent',
      workspaceRoot: root, skipBrowserLaunch: true });
  try {
    const rows = await host.callTool('trace_summary', {},
        { origin: 'ui' });
    assert.equal(rows.length, 1);
    const row = rows[0];
    assert.equal(row.terminal, 'complete');
    assert.deepEqual(row.drop_counters,
        { dropped: 7, failed: 3, sampled_out: 11, partial_observations: 5 });
    assert.deepEqual(row.unconfirmed_producers, ['bnet:z:9:1']);
    assert.equal(row.terminal_reason, null);
  } finally {
    host.close();
  }
});

test('M6 gate: jump resolves via the index trace_file under trace-on naming', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'r1-gui-m6-'));
  writeCapture(root, 'cap-jump', {});
  const host = await createHost({ executable: '/nonexistent',
      workspaceRoot: root, skipBrowserLaunch: true });
  try {
    const ref = 'cap-jump|rtx:a:1:1|1';
    const out = await host.callTool('evidence_jump', { ref },
        { origin: 'ui' });
    assert.equal(out.line, 1);
    assert.ok(Number.isInteger(out.byte_offset));
    assert.ok(out.trace_file.endsWith('trace-on.ndjson'));
    assert.match(panel.renderEvidenceJump(out), /line 1/);
    await assert.rejects(() => host.callTool('evidence_jump',
        { ref: 'cap-jump|none|9' }, { origin: 'ui' }), /not found/);
  } finally {
    host.close();
  }
});

test('renderers: cancel honesty, capability gaps, authorization basis', () => {
  assert.match(panel.renderCancel({ retired_confirmations: 1 }),
      /retired=1.*check Status/s);
  assert.match(panel.renderCapabilities({ counts: {
      available: 10, degraded: 2, unavailable: 4 },
      gaps: [{ name: 'env_current_process', state: 'unavailable',
               reason: 'depends on the fingerprint override layer (P7)' }] }),
      /available=10 degraded=2 unavailable=4/);
  assert.match(panel.renderCapabilities({ counts: {
      available: 10, degraded: 2, unavailable: 4 },
      gaps: [{ name: 'env_current_process', state: 'unavailable',
               reason: 'depends on the fingerprint override layer (P7)' }] }),
      /env_current_process \[unavailable\] depends on the fingerprint/);
  const text = panel.renderAuthorizationRecords([
    { tool: 'jsvmp_trace', decision: 'confirmed', origin: 'ui',
      basis: 'ui-direct-click', reason: 'operator stop' },
    { tool: 'jsvmp_trace', decision: 'denied-by-user', origin: 'agent',
      basis: 'human-denied', reason: 'begin capture' },
  ]);
  assert.match(text, /confirmed via ui — operator stop/);
  assert.match(text, /denied-by-user via agent — begin capture/);
});
