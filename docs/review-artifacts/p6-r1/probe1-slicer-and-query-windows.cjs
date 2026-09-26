// Architect review probe 1 (async): bound() hard-cut, prefix-window
// truncation on REAL captures, relevance() dead branch.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const root = path.resolve(__dirname, '..', '..', '..');
const { createEvidenceIndex } = require(path.join(root, 'xtrace-host/src/evidence-index'));
const { createSlicer } = require(path.join(root, 'xtrace-host/src/slicer'));
const { createAGroupAdapters } = require(path.join(root, 'xtrace-host/src/adapters-agroup'));
const { createWorkspace } = require(path.join(root, 'xtrace-host/src/workspace'));

const out = {};

function fixtureWorkspace(tag) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `arch-${tag}-`));
  const ws = createWorkspace(tmp);
  const index = createEvidenceIndex(path.join(ws.dir('index'), 'index.db'));
  return { tmp, ws, index };
}

(async () => {
  // ---------- (a) bound() hard-cut path + (c) relevance dead branch ----
  {
    const { tmp, ws, index } = fixtureWorkspace('a');
    const dir = path.join(tmp, 'traces', 'cap-a');
    fs.mkdirSync(dir, { recursive: true });
    const ev = [];
    for (let i = 0; i < 50; i++) {
      ev.push({ schema_version: 3, producer_id: 'p1', producer_seq: String(i),
        api: `Some.longish.api.name.number.${i}`, phase: 'call',
        causality: { kind: 'paired', call_id: `s:${i}`, parent_id: null,
                     depth: 0, duration_us: null } });
    }
    fs.writeFileSync(path.join(dir, 'trace.ndjson'),
        ev.map(e => JSON.stringify(e)).join('\n') + '\n');
    fs.writeFileSync(path.join(dir, 'trace.manifest.json'), JSON.stringify({
      capture_id: 'cap-a', observation_coverage: 'partial',
      terminal: { state: 'complete' }, counts: {}, producers: [] }));
    index.rebuildFromDir(path.join(tmp, 'traces'));

    for (const cap of [64, 100, 150, 200]) {
      const tiny = createSlicer({ index, budget: { manifest_summary_bytes: cap } });
      try {
        const s = tiny.manifestSummary('cap-a');
        out[`a_bound_cap${cap}`] = { ok: true, bytes: s.bytes,
          truncated: s.truncated, keys: Object.keys(s).length };
      } catch (e) {
        out[`a_bound_cap${cap}`] = { ok: false, threw: String(e.message).slice(0, 200) };
      }
    }
    const row = index.streamEvents('cap-a', { limit: 1 })[0];
    out.c_relevance = {
      event_causality_typeof: typeof row.event.causality,
      normalized_kind: row.causality,
      relevance_branch_can_fire: row.event.causality === 'paired',
    };
    index.close();
  }

  // ---------- (b) prefix-window truncation on REAL captures ------------
  {
    const valDir = path.join(root, 'chromium/src/out/XTraceIntegration/validation');
    const dirs = [];
    for (const rel of ['p6-e5-ui-4pKd5L/ws/traces', 'p6-e6-QmV7vy/ws/traces']) {
      const p = path.join(valDir, rel);
      if (fs.existsSync(p)) {
        for (const e of fs.readdirSync(p, { withFileTypes: true })) {
          if (e.isDirectory()) dirs.push(path.join(p, e.name));
        }
      }
    }
    const e7 = path.join(valDir, 'p55-e7-ERduFv');
    if (fs.existsSync(e7)) dirs.push(e7);

    const { tmp, ws, index } = fixtureWorkspace('b');
    const results = [];
    for (const d of dirs) {
      let ing;
      try { ing = index.ingestCaptureDir(d); } catch (e) { continue; }
      const traceName = fs.readdirSync(d).find(n => n.endsWith('.ndjson') && n.startsWith('trace'));
      if (!traceName) continue;
      const lines = fs.readFileSync(path.join(d, traceName), 'utf8').split('\n').filter(Boolean);
      let ignTotal = 0, ignAfter5000 = 0, bindTotal = 0, bindAfter100 = 0;
      let firstIgnLine = -1, firstBindLine = -1;
      lines.forEach((l, i) => {
        let e; try { e = JSON.parse(l); } catch { return; }
        if (e.ignition) { ignTotal++; if (firstIgnLine < 0) firstIgnLine = i;
          if (i >= 5000) ignAfter5000++; }
        if (e.channel === 'bindings' || /WebIDL\.entry/.test(String(e.api || ''))) {
          bindTotal++; if (firstBindLine < 0) firstBindLine = i;
          if (i >= 100) bindAfter100++;
        }
      });
      const adapters = createAGroupAdapters({ workspace: ws, index });
      const byName = Object.fromEntries(adapters.map(a => [a.name, a]));
      const jq = await byName.jsvmp_query.run({ capture_id: ing.captureId, limit: 1000 });
      const wq = await byName.webapi_query.run({ capture_id: ing.captureId, limit: 100 });
      const sl = createSlicer({ index }).evidenceSlice(ing.captureId);
      results.push({
        capture: ing.captureId, dir: path.basename(d), trace_file: traceName,
        events: lines.length,
        ignition_total: ignTotal, first_ignition_line: firstIgnLine,
        ignition_beyond_5000: ignAfter5000, jsvmp_query_rows: jq.length,
        bindings_total: bindTotal, first_bindings_line: firstBindLine,
        bindings_beyond_100: bindAfter100, webapi_query_rows: wq.length,
        slice_rows: sl.rows, slice_truncated: sl.truncated,
        slice_discloses_scan_window: Object.keys(sl).filter(k => /window|scan|total/i.test(k)),
      });
    }
    out.b_prefix_window = results;
    index.close();
  }

  console.log(JSON.stringify(out, null, 1));
})().catch(e => { console.error('PROBE ERROR', e); process.exit(1); });
