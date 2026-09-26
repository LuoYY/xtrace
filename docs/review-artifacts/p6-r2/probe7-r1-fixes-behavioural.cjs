// Architect R2 probe 7: behavioural re-check of the R1 fixes through the
// NEW composition root — B6 gate, B5 jump on alt naming, B4 loop
// survival, and the basisHint hole (can an agent-origin call claim
// ui-direct-click and self-confirm?).
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const root = path.resolve(__dirname, '..', '..', '..');
const { createHost } = require(path.join(root, 'xtrace-host/src/host'));
const { createAgentLoop } = require(path.join(root, 'xtrace-host/src/agent-loop'));
const { BASES } = require(path.join(root, 'xtrace-host/src/broker'));

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
        observation_coverage: 'partial', terminal: { state: 'complete' },
        counts: { eligible: String(n), dropped: '7', failed: '3',
                  sampled_out: '11', partial_observations: '5' },
        producers: [{ producer_id: 'rtx:a:1:1', watermark: { received: true } },
                    { producer_id: 'bnet:z:9:1', watermark: { received: false } }] }));
}

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'arch-r2-'));
  capture(path.join(tmp, 'traces', 'cap-alt'), 'cap-alt', 30, 'trace-on.ndjson');
  const host = await createHost({ executable: '/nonexistent', workspaceRoot: tmp,
                                  skipBrowserLaunch: true });

  // ---- B6: skill symlink escape through the composition root ----------
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'arch-r2-out-'));
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'OUTSIDE-SECRET');
  const skills = path.join(host.workspace.root, 'skills');
  fs.mkdirSync(skills, { recursive: true });
  fs.symlinkSync(outside, path.join(skills, 'evil'));
  try {
    const r = await host.callTool('skill_read_resource',
        { name: 'evil', resource: 'secret.txt' }, { origin: 'agent' });
    out.B6_skill_escape = { escaped: true, content: r && r.content };
  } catch (e) {
    out.B6_skill_escape = { escaped: false, rejected: String(e.message).slice(0, 90) };
  }

  // ---- B5: jump on a non-conventional filename ------------------------
  try {
    const j = await host.callTool('evidence_jump',
        { ref: 'cap-alt|rtx:a:1:1|3' }, { origin: 'ui' });
    out.B5_jump_alt_name = { ok: true, line: j.line, byte_offset: j.byte_offset,
      trace_file: path.basename(j.trace_file) };
  } catch (e) {
    out.B5_jump_alt_name = { ok: false, threw: String(e.message).slice(0, 120) };
  }

  // ---- B5 substance: does the status path carry the disk truth? --------
  const rows = await host.callTool('trace_summary', {}, { origin: 'ui' });
  const gui = require(path.join(root, 'xtrace-gui/src/main/evidenceService'));
  const panelRow = rows.find(r => r.capture_id === 'cap-alt');
  out.B5_status_fields = {
    trace_summary_row_keys: Object.keys(panelRow),
    drop_counters_field_present: 'drop_counters' in panelRow,
    unconfirmed_field_present: 'unconfirmed_producers' in panelRow,
    enrichStatusRows_has_consumers: (() => {
      const files = [];
      const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) {
          const p = path.join(d, e.name);
          if (e.isDirectory() && e.name !== 'node_modules') walk(p);
          else if (/\.js$/.test(e.name)) files.push(p); } };
      walk(path.join(root, 'xtrace-gui/src')); walk(path.join(root, 'scripts'));
      return files.filter(f => /enrichStatusRows/.test(fs.readFileSync(f, 'utf8')))
          .map(f => path.relative(root, f));
    })(),
    disk_truth: { dropped: 7, failed: 3, sampled_out: 11, partial: 5,
                  unconfirmed: ['bnet:z:9:1'] },
    gui_helper_exports: Object.keys(gui),
  };

  // ---- B4: does a slice error still unwind the loop? ------------------
  const loop = createAgentLoop({ broker: host.broker,
      tools: [...host.tools.values()], index: host.index,
      workspace: host.workspace, host,
      model: async (s) => s.iteration === 1
          ? { type: 'slice', shape: 'no-such-shape', capture_id: 'cap-alt' }
          : { type: 'final', answer: { survived: true } },
      limits: { slice_budget: { manifest_summary_bytes: 48 } } });
  try {
    const r = await loop.run();
    out.B4_loop = { rejected: false, status: r.status,
      slice_error_logged: r.log.some(l => l.type === 'slice-error') };
  } catch (e) {
    out.B4_loop = { rejected: true, threw: String(e.message).slice(0, 120) };
  }

  // ---- M13: what does the loop actually charge for a big tool result? --
  {
    let charged = null;
    const bigTool = { name: 'big_read', tier: 'read-evidence',
      run: async () => ({ blob: 'x'.repeat(60000) }) };
    host.tools.set('big_read', host.broker.register(bigTool));
    const l2 = createAgentLoop({ broker: host.broker,
        tools: [...host.tools.values()], index: host.index,
        workspace: host.workspace, host,
        model: async (s) => {
          if (s.iteration <= 3) return { type: 'tool', name: 'big_read', args: {} };
          charged = s.budget.used;
          return { type: 'final', answer: { used: s.budget.used } };
        },
        limits: { context_bytes: 131072 } });
    const r2 = await l2.run();
    out.M13_accounting = { three_results_of_60001_bytes_each: 180003,
      budget_used_reported: r2.answer.used, charged };
  }

  // ---- R1.6-D1: can an AGENT-origin call claim ui-direct-click? -------
  try {
    const r = await host.callTool('env_create',
        { name: 'agent-made-env', notes: 'x' },
        { origin: 'agent', reason: 'agent wants an env',
          basisHint: BASES.UI_DIRECT_CLICK });
    const ledger = fs.readFileSync(host.broker.ledgerPath, 'utf8').trim()
        .split('\n').map(l => JSON.parse(l));
    const conf = ledger.filter(e => e.decision === 'confirmed').pop();
    out.D1_basishint_hole = { self_confirmed: true, created: r && r.name,
      audit_row: conf && { origin: conf.origin, basis: conf.basis, tool: conf.tool } };
  } catch (e) {
    out.D1_basishint_hole = { self_confirmed: false, threw: String(e.message).slice(0, 120) };
  }

  await host.close();
  console.log(JSON.stringify(out, null, 1));
})().catch(e => { console.error('PROBE ERROR', e); process.exit(1); });
