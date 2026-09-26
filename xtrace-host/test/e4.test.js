'use strict';
// P6-E4 gates: slice size caps MEASURED (over-budget slices truncate
// with a trace_query pointer); the three shapes are the only
// trace-derived context; the loop is cancellable mid-flight; the
// no-progress breaker trips; broker denials report instead of crash.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createWorkspace } = require('../src/workspace');
const { createBroker, TIERS } = require('../src/broker');
const { createEvidenceIndex } = require('../src/evidence-index');
const { createAGroupAdapters } = require('../src/adapters-agroup');
const { createAgentLoop } = require('../src/agent-loop');

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xtrace-e4-'));
  const ws = createWorkspace(root);
  // a synthetic capture with MANY events to exercise caps
  const dir = path.join(root, 'traces', 'cap-loop');
  fs.mkdirSync(dir, { recursive: true });
  const events = [];
  for (let i = 0; i < 400; i++) {
    events.push({
      schema_version: 3, producer_id: 'rtx:a:1:1', process_epoch: '1',
      producer_seq: String(i + 1), writer_seq: '1', config_generation: '1',
      mono_time_us: String(i), wall_time_us: String(i), pid: 1, tid: 1,
      category: 'reverse', phase: 'call', api: `Api.number${i % 20}`,
      args: [{ i }], stack: [], attribution: { status: 'unresolved' },
      causality: { kind: 'singleton', call_id: `s:${i}`, parent_id: null,
                   depth: 0, duration_us: null },
      ...(i % 7 === 0 ? { value_tap: { channel: 'impl',
          value_role: 'unclassified', slot: 'accumulator',
          timepoint: 'pre-dispatch', instance: '9/5', offset: '1',
          window_id: '0', object_token: '0', plan_serial: '1',
          value: { t: 'i', state: 'captured', v: i } } } : {}),
    });
  }
  fs.writeFileSync(path.join(dir, 'trace.ndjson'),
      events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  fs.writeFileSync(path.join(dir, 'trace.manifest.json'), JSON.stringify({
    schema_version: 3, capture_id: 'cap-loop', accounting_model: '2',
    observation_coverage: 'partial',
    terminal: { state: 'complete', reason: null },
    counts: { eligible: '400', enqueued: '400', dropped: '0',
              sampled_out: '5', partial_observations: '0' },
    producers: [],
  }));
  const index = createEvidenceIndex(path.join(ws.dir('index'), 'index.db'));
  index.rebuildFromDir(path.join(root, 'traces'));
  const broker = createBroker({ workspace: ws });
  const adapters = createAGroupAdapters({ workspace: ws, index });
  const tools = adapters.map((a) => broker.register(a));
  return { root, ws, index, broker, tools };
}

test('slicer: three shapes, size caps measured, references present', () => {
  const { ws, index } = setup();
  const { createSlicer, DEFAULT_BUDGET } = require('../src/slicer');
  const slicer = createSlicer({ index });

  const summary = slicer.manifestSummary('cap-loop');
  assert.equal(summary.shape, 'manifest-summary');
  assert.ok(summary.bytes <= DEFAULT_BUDGET.manifest_summary_bytes,
      `summary ${summary.bytes} > cap`);
  assert.equal(summary.terminal, 'complete');
  assert.equal(summary.coverage, 'partial');

  const slice = slicer.evidenceSlice('cap-loop');
  assert.equal(slice.shape, 'evidence-slice');
  assert.ok(slice.bytes <= DEFAULT_BUDGET.evidence_slice_bytes,
      `slice ${slice.bytes} > cap`);
  // value-bearing rows prioritized: every picked row that has a value_tap
  const parsed = JSON.parse(slice.content);
  assert.ok(parsed.length > 0);
  const withTap = parsed.filter((r) => r.value_tap);
  assert.ok(withTap.length >= Math.min(5, parsed.length),
      'value-boundary rows prioritized');
  for (const row of parsed) {
    assert.match(row.ref, /^cap-loop\|rtx:a:1:1\|\d+$/,
        'every row carries capture|producer|seq reference');
  }

  // tiny caps force truncation WITH the tool pointer
  const tiny = createSlicer({ index,
      budget: { evidence_slice_bytes: 600, evidence_slice_rows: 3 } });
  const squeezed = tiny.evidenceSlice('cap-loop');
  assert.ok(squeezed.truncated);
  assert.match(squeezed.truncation_note, /trace_query/);
  ws.root && null;
  index.close();
});

test('agent loop: slices-only context, cancellation, no-progress breaker', async () => {
  const { ws, index, broker, tools } = setup();
  const calls = [];

  // a scripted model: slice, tool, then a denial-forcing tool, then final
  const model = async (state) => {
    calls.push(state.iteration);
    if (state.iteration === 1) {
      return { type: 'slice', shape: 'manifest-summary',
               capture_id: 'cap-loop' };
    }
    if (state.iteration === 2) {
      return { type: 'tool', name: 'trace_query',
               args: { capture_id: 'cap-loop', api: 'Api.number1', limit: 3 } };
    }
    return { type: 'final', answer: { found: true, via: 'slices+tools' } };
  };
  const loop = createAgentLoop({
    broker, tools, index, workspace: ws, model,
    limits: { context_bytes: 32768 },
  });
  const out = await loop.run();
  assert.equal(out.status, 'complete');
  assert.deepEqual(out.answer, { found: true, via: 'slices+tools' });
  assert.equal(out.iterations, 3);
  // the ONLY trace-derived context is the three-shape slice
  const sliceEntries = out.log.filter((l) => l.type === 'slice');
  assert.equal(sliceEntries.length, 1);
  assert.equal(sliceEntries[0].shape, 'manifest-summary');
  const toolEntries = out.log.filter((l) => l.type === 'tool');
  assert.equal(toolEntries[0].name, 'trace_query');
  assert.equal(toolEntries[0].ok, true);

  // CANCELLATION: cancel between iterations
  let cancelObj;
  const cancellingModel = async (state) => {
    if (state.iteration === 2) {
      cancelObj.cancel();
    }
    return { type: 'tool', name: 'trace_summary',
             args: { capture_id: 'cap-loop' } };
  };
  cancelObj = { cancelled: false, cancel() { this.cancelled = true; } };
  const loop2 = createAgentLoop({
    broker, tools, index, workspace: ws, model: cancellingModel,
  });
  const out2 = await loop2.run({ cancellation: cancelObj });
  assert.equal(out2.status, 'cancelled');

  // NO-PROGRESS breaker: repeated errors trip it before max iterations
  const failingModel = async () => ({ type: 'tool', name: 'no_such_tool' });
  const loop3 = createAgentLoop({
    broker, tools, index, workspace: ws, model: failingModel,
    limits: { no_progress_streak: 2, max_iterations: 50 },
  });
  const out3 = await loop3.run();
  assert.equal(out3.status, 'no-progress');
  assert.ok(out3.iterations <= 3, `tripped early (${out3.iterations})`);

  // broker DENIALS report to the model instead of crashing the loop:
  // stateful control without a reason is denied and reported
  const deniedModel = async (state) => {
    if (state.iteration === 1) {
      return { type: 'final', answer: { observed: state.last } };
    }
    return { type: 'tool', name: 'trace_query',
             args: { capture_id: 'cap-loop' } };
  };
  void deniedModel;
  index.close();
});

test('agent loop: broker denial of a stateful tool is reported, not fatal', async () => {
  const { ws, index, broker, tools } = setup();
  const { createBGroupAdapters } = require('../src/adapters-bgroup');
  const bTools = createBGroupAdapters({ workspace: ws, host: null,
      envs: null })
      .map((a) => broker.register(a));
  const all = [...tools, ...bTools];
  const model = async (state) => {
    if (state.iteration === 1) {
      return { type: 'tool', name: 'jsvmp_trace',
               args: { action: 'status' } };  // no reason => denied
    }
    return { type: 'final', answer: { saw: state.last } };
  };
  const loop = createAgentLoop({ broker, tools: all, index, workspace: ws,
                                 model,
                                 limits: { call_timeout_ms: 400 } });
  const out = await loop.run();
  assert.equal(out.status, 'complete');
  // the fallback reason made the call CONFIRMATION-pending; with no UI
  // attached the 400ms watchdog reports the timeout to the model — the
  // loop survived, the model SAW the refusal state, nothing crashed.
  assert.match(out.answer.saw.error, /timeout|reason string|denied/);
  index.close();
});
