'use strict';
// P6-E5 (first slice) gates: evidence service over real workspace
// shapes (complete+partial, incomplete+unconfirmed, timeout, cancel,
// resume adoption) and the renderer panel rendering — the LOGIC layer
// of the five scenarios. The five-scenario INTERACTIVE acceptance
// (launching the app, clicking, checking console/network) is the E5
// second slice and is NOT claimed here.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createEvidenceService } = require('../src/main/evidenceService');
const panel = require('../src/renderer/evidencePanel');

function writeCapture(root, name, { terminal, coverage, unconfirmed }) {
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
  ];
  fs.writeFileSync(path.join(dir, 'trace.ndjson'),
      events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  fs.writeFileSync(path.join(dir, 'trace.manifest.json'), JSON.stringify({
    schema_version: 3, capture_id: name, accounting_model: '2',
    observation_coverage: coverage,
    terminal: terminal === 'complete'
        ? { state: 'complete', reason: null }
        : { state: 'incomplete', reason: 'producer-unconfirmed' },
    counts: { eligible: '5', enqueued: '5', dropped: '1', accepted: '5',
              written: '4', failed: '1', sampled_out: '2',
              partial_observations: '1' },
    producers: [
      { producer_id: 'rtx:a:1:1', process_epoch: '1', eligible: '5',
        enqueued: '5', dropped: '1', sampled_out: '2',
        partial_observations: '1', accepted: '5', written: '4',
        failed: '1', watermark: { received: true } },
      ...(unconfirmed ? [{ producer_id: 'bnet:z:9:1', process_epoch: '9',
          eligible: null, enqueued: null, dropped: null,
          watermark: { received: false } }] : []),
    ],
  }));
  return dir;
}

function service(root) {
  const svc = createEvidenceService({ host: null });
  svc.openWorkspace(root);
  return svc;
}

test('evidence service: status carries terminal/coverage/drop counters', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'e5-'));
  writeCapture(root, 'cap-ok', { terminal: 'complete',
                                 coverage: 'partial', unconfirmed: false });
  writeCapture(root, 'cap-bad', { terminal: 'incomplete',
                                  coverage: 'partial', unconfirmed: true });
  const svc = service(root);

  const ok = svc.captureStatus('cap-ok')[0];
  assert.equal(ok.terminal, 'complete');
  assert.equal(ok.coverage, 'partial');
  assert.deepEqual(ok.drop_counters,
      { dropped: 1, failed: 1, sampled_out: 2, partial_observations: 1 });
  assert.equal(ok.unconfirmed_producers.length, 0);

  const bad = svc.captureStatus('cap-bad')[0];
  assert.equal(bad.terminal, 'incomplete');
  assert.equal(bad.terminal_reason, 'producer-unconfirmed');
  assert.deepEqual(bad.unconfirmed_producers, ['bnet:z:9:1']);

  // renderer rendering of both shapes
  const text = panel.renderCaptureStatus(svc.captureStatus());
  assert.match(text, /cap-ok \| terminal=complete \| coverage=partial/);
  assert.match(text, /sampled_out=2/);
  assert.match(text, /cap-bad \| terminal=incomplete \(producer-unconfirmed\)/);
  assert.match(text, /unconfirmed producers: 1/);
});

test('evidence service: stopProgress timeout + cancel + dead-browser', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'e5b-'));
  writeCapture(root, 'cap-x', { terminal: 'complete',
                                coverage: 'full', unconfirmed: false });
  const svc = service(root);
  // scenario 2 (no browser): stop with a dead pipe reports timeout
  const out = await svc.stopProgress({ deadlineMs: 100, pollMs: 20 });
  assert.equal(out.state, 'stop-timeout');
  assert.match(panel.renderStopProgress(out), /TIMEOUT/);

  // scenario 5: adopt read-only after a restart (resume path)
  const dir = path.join(root, 'traces', 'cap-x');
  fs.rmSync(path.join(root, 'index', 'index.db'));
  const svc2 = service(root);
  const adopted = svc2.adoptReadOnly(dir);
  assert.equal(adopted.adopted, true);
  assert.equal(adopted.eventCount, 1);
  assert.equal(svc2.captureStatus('cap-x')[0].terminal, 'complete');
});

test('evidence service: authorization records + evidence jump refs', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'e5c-'));
  const dir = writeCapture(root, 'cap-auth', { terminal: 'complete',
                                               coverage: 'full',
                                               unconfirmed: false });
  const svc = service(root);
  // a broker ledger lands when tools run; simulate one row
  fs.mkdirSync(path.join(root, 'ledger'), { recursive: true });
  fs.writeFileSync(path.join(root, 'ledger', 'broker-1.jsonl'), JSON.stringify({
    tool: 'jsvmp_trace', tier: 'stateful-control', origin: 'ui',
    decision: 'confirmed', reason: 'controlled capture'
  }) + '\n');
  const records = svc.authorizationRecords();
  assert.equal(records.length, 1);
  assert.equal(records[0].decision, 'confirmed');
  const text = panel.renderAuthorizationRecords(records);
  assert.match(text, /jsvmp_trace confirmed via ui — controlled capture/);
  assert.match(panel.renderAuthorizationRecords([]), /no authorization records/);

  // evidence jump: ref resolves to the trace line
  const ref = panel.evidenceRefFromEvent({
    capture_id: 'cap-auth', producer_id: 'rtx:a:1:1', producer_seq: '1' });
  assert.equal(ref, 'cap-auth|rtx:a:1:1|1');
  const jump = svc.evidenceJump(ref);
  assert.equal(jump.api, 'Document.cookie.set');
  assert.equal(jump.line, 1);
  assert.throws(() => svc.evidenceJump('cap-auth|none|99'), /not found/);
  void dir;
});
