// Architect review probe 2: agent-loop crash on slice error; readSkill
// symlink escape (string-prefix instead of realpath gate); evidenceJump
// hardcoded trace.ndjson filename.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const root = path.resolve(__dirname, '..', '..', '..');
const { createWorkspace } = require(path.join(root, 'xtrace-host/src/workspace'));
const { createBroker, TIERS } = require(path.join(root, 'xtrace-host/src/broker'));
const { createEvidenceIndex } = require(path.join(root, 'xtrace-host/src/evidence-index'));
const { createAGroupAdapters } = require(path.join(root, 'xtrace-host/src/adapters-agroup'));
const { createAgentLoop } = require(path.join(root, 'xtrace-host/src/agent-loop'));
const { createEvidenceService } = require(path.join(root, 'xtrace-gui/src/main/evidenceService'));

const out = {};

function capture(dir, name, n, traceName = 'trace.ndjson', manifestName = null) {
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
  fs.writeFileSync(path.join(dir, traceName), ev.map(e => JSON.stringify(e)).join('\n') + '\n');
  fs.writeFileSync(path.join(dir, manifestName || traceName.replace(/\.ndjson$/, '.manifest.json')),
      JSON.stringify({ schema_version: 3, capture_id: name, accounting_model: '2',
        observation_coverage: 'partial', terminal: { state: 'complete' },
        counts: { eligible: String(n), sampled_out: '0', partial_observations: '0' },
        producers: [] }));
}

(async () => {
  // ---------- (1) agent loop: does a SLICE error get reported or crash? --
  {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'arch-loop-'));
    const ws = createWorkspace(tmp);
    capture(path.join(tmp, 'traces', 'cap-l'), 'cap-l', 40);
    const index = createEvidenceIndex(path.join(ws.dir('index'), 'index.db'));
    index.rebuildFromDir(path.join(tmp, 'traces'));
    const broker = createBroker({ workspace: ws });
    const tools = createAGroupAdapters({ workspace: ws, index }).map(a => broker.register(a));
    const model = async (state) => state.iteration === 1
        ? { type: 'slice', shape: 'manifest-summary', capture_id: 'cap-l' }
        : { type: 'final', answer: { done: true } };
    const loop = createAgentLoop({ broker, tools, index, workspace: ws, model,
      limits: { slice_budget: { manifest_summary_bytes: 120 } } });
    try {
      const r = await loop.run();
      out.loop_slice_error = { crashed: false, status: r.status, log: r.log };
    } catch (e) {
      out.loop_slice_error = { crashed: true, threw: String(e.message).slice(0, 140),
        note: 'the loop unwound instead of reporting to the model' };
    }
    // tool error, for contrast (should be reported, not fatal)
    const model2 = async (state) => state.iteration === 1
        ? { type: 'tool', name: 'trace_query', args: { capture_id: 'nope' } }
        : { type: 'final', answer: { saw: state.last } };
    const loop2 = createAgentLoop({ broker, tools, index, workspace: ws, model: model2 });
    try {
      const r2 = await loop2.run();
      out.loop_tool_error = { crashed: false, status: r2.status };
    } catch (e) {
      out.loop_tool_error = { crashed: true, threw: String(e.message).slice(0, 140) };
    }
    index.close();
  }

  // ---------- (2) readSkill symlink escape ------------------------------
  {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'arch-skill-'));
    const ws = createWorkspace(tmp);
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'arch-outside-'));
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'OUTSIDE-OF-WORKSPACE-SECRET');
    const skills = path.join(ws.root, 'skills');
    fs.mkdirSync(skills, { recursive: true });
    fs.symlinkSync(outside, path.join(skills, 'evil'));
    const index = createEvidenceIndex(path.join(ws.dir('index'), 'index.db'));
    const adapters = createAGroupAdapters({ workspace: ws, index });
    const byName = Object.fromEntries(adapters.map(a => [a.name, a]));
    try {
      const r = await byName.skill_read_resource.run({ name: 'evil', resource: 'secret.txt' });
      out.skill_symlink_escape = { escaped: true, content: r && r.content,
        note: 'readSkill used a string-prefix check, not the realpath gate' };
    } catch (e) {
      out.skill_symlink_escape = { escaped: false, threw: String(e.message).slice(0, 120) };
    }
    // contrast: workspace.assertInside on the same target
    try {
      ws.assertInside(path.join(skills, 'evil', 'secret.txt'), 'probe');
      out.skill_symlink_escape.assertInside = 'ALLOWED (unexpected)';
    } catch (e) {
      out.skill_symlink_escape.assertInside = 'rejected: ' + e.code;
    }
    index.close();
  }

  // ---------- (3) evidenceJump on a capture not named trace.ndjson -------
  {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'arch-jump-'));
    const ws = createWorkspace(tmp);
    capture(path.join(tmp, 'traces', 'cap-j'), 'cap-j', 20, 'trace-on.ndjson');
    const svc = createEvidenceService({ host: null });
    svc.openWorkspace(tmp);
    const ref = 'cap-j|rtx:a:1:1|3';
    try {
      const j = svc.evidenceJump(ref);
      out.evidenceJump_alt_filename = { ok: true, line: j.line, api: j.api };
    } catch (e) {
      out.evidenceJump_alt_filename = { ok: false, threw: String(e.message).slice(0, 160) };
    }
    // same shape but the conventional filename, for contrast
    capture(path.join(tmp, 'traces', 'cap-k'), 'cap-k', 20, 'trace.ndjson');
    svc.openWorkspace(tmp);
    try {
      const j2 = svc.evidenceJump('cap-k|rtx:a:1:1|3');
      out.evidenceJump_conventional = { ok: true, line: j2.line };
    } catch (e) {
      out.evidenceJump_conventional = { ok: false, threw: String(e.message).slice(0, 160) };
    }
    // real dp551 capture dir (trace-on.ndjson), adopted read-only
    const dp = path.join(root, 'chromium/src/out/XTraceIntegration/validation/p6-e0-dp551-S0EI47');
    out.dp551_dir_files = fs.existsSync(dp) ? fs.readdirSync(dp).filter(f => f.endsWith('.json') || f.endsWith('.ndjson')) : null;
  }

  console.log(JSON.stringify(out, null, 1));
})().catch(e => { console.error('PROBE ERROR', e); process.exit(1); });
