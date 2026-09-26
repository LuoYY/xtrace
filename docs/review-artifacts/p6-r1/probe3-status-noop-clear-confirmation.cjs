// Architect review probe 3: silent-wrong captureStatus on alt filenames;
// jsvmp_trace clear no-op; broker concurrent-confirmation hang; late
// confirmation executing a side effect AFTER the loop reported timeout;
// stopProgress unhandled rejection.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const root = path.resolve(__dirname, '..', '..', '..');
const { createWorkspace } = require(path.join(root, 'xtrace-host/src/workspace'));
const { createBroker, TIERS } = require(path.join(root, 'xtrace-host/src/broker'));
const { createEvidenceIndex } = require(path.join(root, 'xtrace-host/src/evidence-index'));
const { createBGroupAdapters } = require(path.join(root, 'xtrace-host/src/adapters-bgroup'));
const { createAgentLoop } = require(path.join(root, 'xtrace-host/src/agent-loop'));
const { createEvidenceService } = require(path.join(root, 'xtrace-gui/src/main/evidenceService'));

const out = {};

function capture(dir, name, n, traceName) {
  fs.mkdirSync(dir, { recursive: true });
  const ev = [];
  for (let i = 0; i < n; i++) {
    ev.push({ schema_version: 3, producer_id: 'rtx:a:1:1', process_epoch: '1',
      producer_seq: String(i + 1), writer_seq: '1', config_generation: '1',
      mono_time_us: String(i), wall_time_us: String(i), pid: 1, tid: 1,
      category: 'reverse', phase: 'call', api: `Api.n${i % 5}`, args: [],
      stack: [], attribution: { status: 'unresolved' },
      causality: { kind: 'singleton', call_id: `s:${i}`, parent_id: null,
                   depth: 0, duration_us: null } });
  }
  fs.writeFileSync(path.join(dir, traceName),
      ev.map(e => JSON.stringify(e)).join('\n') + '\n');
  fs.writeFileSync(path.join(dir, traceName.replace(/\.ndjson$/, '.manifest.json')),
      JSON.stringify({ schema_version: 3, capture_id: name, accounting_model: '2',
        observation_coverage: 'partial',
        terminal: { state: 'incomplete', reason: 'producer-unconfirmed' },
        counts: { eligible: String(n), dropped: '7', failed: '3',
                  sampled_out: '11', partial_observations: '5' },
        producers: [{ producer_id: 'rtx:a:1:1', watermark: { received: true } },
                    { producer_id: 'bnet:z:9:1', watermark: { received: false } }] }));
}

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'arch-p3-'));
  const ws = createWorkspace(tmp);
  capture(path.join(tmp, 'traces', 'cap-alt'), 'cap-alt', 30, 'trace-on.ndjson');
  capture(path.join(tmp, 'traces', 'cap-std'), 'cap-std', 30, 'trace.ndjson');

  // ---------- (a) captureStatus on a non-conventional filename ----------
  const svc = createEvidenceService({ host: null });
  svc.openWorkspace(tmp);
  const pick = (rows, id) => rows.find(r => r.capture_id === id);
  const alt = pick(svc.captureStatus(), 'cap-alt');
  const std = pick(svc.captureStatus(), 'cap-std');
  out.a_captureStatus = {
    conventional: { terminal_reason: std.terminal_reason, drops: std.drop_counters,
                    unconfirmed: std.unconfirmed_producers },
    alt_filename: { terminal_reason: alt.terminal_reason, drops: alt.drop_counters,
                    unconfirmed: alt.unconfirmed_producers },
    manifest_on_disk_has: { reason: 'producer-unconfirmed', dropped: 7, failed: 3,
                            sampled_out: 11, partial: 5, unconfirmed: ['bnet:z:9:1'] },
  };

  // ---------- (b) jsvmp_trace clear: does it change ANY state? ----------
  {
    const calls = [];
    const fakeHost = { closed: false, traceFile: null,
      send: async (m) => { calls.push(m); return { state: 'active' }; },
      capabilities: async () => ({ enhanced: true, tools: [] }) };
    const b = createBGroupAdapters({ workspace: ws, host: fakeHost, envs: null });
    const clear = b.find(x => x.name === 'jsvmp_trace');
    const r = await clear.run({ action: 'clear' });
    out.b_clear_noop = { returned: r, cdp_calls_made: calls,
      mutating_call_made: calls.some(m => /stop|clear|reset/i.test(m)) };
  }

  // ---------- (c) broker: two concurrent same-key confirmations ---------
  {
    const broker = createBroker({ workspace: ws });
    let runs = 0;
    const tool = broker.register({ name: 'jsvmp_trace.start',
      tier: TIERS.STATEFUL_CONTROL, run: async () => { runs += 1; return { runs }; } });
    const ctx = { origin: 'ui', reason: 'same key concurrency probe' };
    const p1 = broker.execute(tool, {}, ctx);
    const p2 = broker.execute(tool, {}, ctx);
    await new Promise(r => setTimeout(r, 20));
    const ids = broker.pendingIds();
    broker.resolveConfirmation(ids[0], true);
    const settled = await Promise.race([
      Promise.allSettled([p1, p2]).then(() => 'both-settled'),
      new Promise(r => setTimeout(() => r('only-one-settled'), 400)),
    ]);
    out.c_concurrent_confirmation = { pending_ids: ids.length, settled,
      tool_runs: runs, pending_after: broker.pendingCount() };
  }

  // ---------- (d) late confirmation fires AFTER the loop gave up ---------
  {
    const broker = createBroker({ workspace: ws });
    const sideEffects = [];
    const tool = broker.register({ name: 'jsvmp_trace',
      tier: TIERS.STATEFUL_CONTROL,
      run: async () => { sideEffects.push('startCapture-executed'); return { ok: 1 }; } });
    const model = async (state) => state.iteration === 1
        ? { type: 'tool', name: 'jsvmp_trace', args: { action: 'start' } }
        : { type: 'final', answer: { saw: state.last } };
    const loop = createAgentLoop({ broker, tools: [tool], index: null,
      workspace: ws, model, limits: { call_timeout_ms: 120 } });
    const r = await loop.run();
    out.d_late_confirmation = {
      loop_reported: r.answer.saw.error ? 'timeout/error to model' : 'ok',
      side_effects_at_that_point: sideEffects.length,
      pending_confirmations_still_open: broker.pendingCount(),
    };
    // a human (or a stale UI) approves LATER
    for (const id of broker.pendingIds()) broker.resolveConfirmation(id, true);
    await new Promise(r2 => setTimeout(r2, 60));
    out.d_late_confirmation.side_effects_after_late_approval = sideEffects.length;
    const ledger = fs.readFileSync(broker.ledgerPath, 'utf8').trim().split('\n').map(l => JSON.parse(l));
    out.d_late_confirmation.ledger_tail = ledger.slice(-3)
        .map(e => `${e.decision}:${e.tool}`);
  }

  console.log(JSON.stringify(out, null, 1));

  // ---------- (e) stopProgress: rejection after the deadline ------------
  const hungHost = { closed: false, traceFile: null,
    send: () => new Promise((_, rej) =>
        setTimeout(() => rej(new Error('pipe died mid-stop')), 250)) };
  svc.setHost(hungHost);
  const res = await svc.stopProgress({ deadlineMs: 60, pollMs: 20 });
  out.e_stop_timeout_result = res.state;
  console.log(JSON.stringify({ e_stop_timeout: out.e_stop_timeout_result }));
  process.on('unhandledRejection', (e) => {
    console.log('UNHANDLED_REJECTION_OBSERVED: ' + String(e && e.message));
    process.exit(9);
  });
  await new Promise(r => setTimeout(r, 600));
  console.log('NO_UNHANDLED_REJECTION_WITHIN_600MS');
})().catch(e => { console.error('PROBE ERROR', e); process.exit(1); });
