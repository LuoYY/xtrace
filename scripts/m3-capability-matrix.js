#!/usr/bin/env node
// M3-E0 capability-matrix first cut (A+B groups): AUTO-GENERATED from
// the composition root's negotiated surface — no hand-written rows.
// For each tool: name / tier / negotiated state / reason, plus "gate"
// = a shipped gate that exercises the tool (declared map below, the
// generator FAILS if a declared gate file is missing).
//
// Acceptance (M3 handoff §5 E0): the matrix runs against a REAL host
// (live ChromiumX) and a fixture host, dumps JSON + markdown, and the
// available/degraded/unavailable counts must match the live
// negotiation. No hand-editing of the output.
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const { createHost } = require(path.join(ROOT, 'xtrace-host/src/host'));

// R1-4 (B4): the tool UNIVERSE comes from the inventory FILE — the
// generator parses the 66 `| \`name\` | ... | 是/否 | ... |` rows and
// asserts the matrix row set == the inventory set. Silent absence is
// the third-recurrence defect class; this kills it structurally.
function parseInventory() {
  const text = fs.readFileSync(
      path.join(ROOT, 'docs/tool-inventory.md'), 'utf8');
  const tools = new Set();
  for (const line of text.split('\n')) {
    const m = line.match(/^\|\s*`([a-z_0-9]+)`\s*\|/);
    if (m && m[1] !== 'T') {
      tools.add(m[1]);
    }
  }
  return tools;
}

// gate provenance: tool -> shipped gate that exercises it (the
// generator asserts each named file exists; empty = unexercised, which
// the matrix discloses as a gap rather than hiding)
const GATES = {
  'trace_query': 'xtrace-host/test/r1-core.test.js',
  'trace_summary': 'xtrace-host/test/e6-structural.test.js',
  'api_top': null,   // disclosed gap

  'assets_list': null,   // disclosed gap
  'asset_read': null,   // disclosed gap
  'code_search': 'xtrace-host/test/r1-core.test.js',
  'scripts_list': 'xtrace-host/test/r1-core.test.js',
  'jsvmp_query': 'xtrace-host/test/r1-adapters.test.js',
  'webapi_query': 'xtrace-host/test/r1-adapters.test.js',
  'find_param_entry': 'xtrace-host/test/r1-core.test.js',
  'crypto_scan': 'xtrace-host/test/r1-core.test.js',
  'evidence_jump': 'xtrace-host/test/r1-adapters.test.js',
  'notes_get': 'xtrace-host/test/r1-core.test.js',
  'recall': 'scripts/p6-e5-ui-scenarios.cjs',
  'jsvmp_split_dispatcher': 'unavailable-with-reason — no gate required',
  'jsvmp_disassemble': 'unavailable-with-reason — no gate required',
  'env_current_process': 'unavailable-with-reason — no gate required',
  'env_read_current_process_config': 'unavailable-with-reason — no gate required',
  'env_write_current_process_config': 'unavailable-with-reason — no gate required',
  'env_reset_current_process_default': 'unavailable-with-reason — no gate required',
  'skill_list': 'xtrace-host/test/r1-core.test.js',
  'skill_get': 'xtrace-host/test/r1-core.test.js',
  'skill_read_resource': 'xtrace-host/test/r1-adapters.test.js',
  'jsvmp_trace': 'xtrace-host/test/r1-core.test.js (composition root)',
  // M4-E0 top-up (register M4-7, MD4): the ten formerly-gapped
  // available/degraded tools now carry REAL product-path gates in the
  // E0 coverage file (live browser / live control domain / real FS).
  'jsvmp_status': 'xtrace-host/test/e0-coverage-topup.test.js',
  'webapi_trace': 'xtrace-host/test/e0-coverage-topup.test.js',
  'scripts_capture_all': 'xtrace-host/test/e0-coverage-topup.test.js',
  'env_create': 'scripts/p6-e6-closed-loop.cjs',
  'env_list': 'xtrace-host/test/e0-coverage-topup.test.js',
  'env_status': 'xtrace-host/test/e0-coverage-topup.test.js',
  'env_update': 'xtrace-host/test/e0-coverage-topup.test.js',
  'env_open': 'xtrace-host/test/r1-core.test.js',
  'env_close': 'xtrace-host/test/e0-coverage-topup.test.js',
  'env_delete': 'xtrace-host/test/e0-coverage-topup.test.js',
  'env_current': 'xtrace-host/test/e0-coverage-topup.test.js',
  'page_navigate': 'xtrace-host/test/e3-cgroup.test.js',
  'page_elements': 'xtrace-host/test/e3-cgroup.test.js',
  'page_click': 'xtrace-host/test/e3-cgroup.test.js',
  'page_type': 'xtrace-host/test/e3-cgroup.test.js',
  'page_scroll': 'xtrace-host/test/e3-cgroup.test.js',
  'page_screenshot': 'xtrace-host/test/e3-cgroup.test.js',
  'page_info': 'xtrace-host/test/e3-cgroup.test.js',
  'page_eval': 'xtrace-host/test/e3-cgroup.test.js',
  'hook_inject': 'xtrace-host/test/e3-cgroup.test.js',
  'cookies': 'xtrace-host/test/e3-cgroup.test.js',
  'net_capture': 'xtrace-host/test/e3-cgroup.test.js',
  'net_list': 'xtrace-host/test/e3-cgroup.test.js',
  'net_get': 'xtrace-host/test/e3-cgroup.test.js',
  'page_automation_scan': 'xtrace-host/test/e3-cgroup.test.js',
  'fs_list': 'xtrace-host/test/e2-dgroup.test.js',
  'fs_read': 'xtrace-host/test/e2-dgroup.test.js',
  'fs_write': 'xtrace-host/test/e2-dgroup.test.js',
  'fs_mkdir': 'xtrace-host/test/e0-coverage-topup.test.js',
  'fs_copy': 'xtrace-host/test/e2-dgroup.test.js',
  'scripts_save': 'xtrace-host/test/e2-dgroup.test.js',
  'notes_add': 'unavailable-with-reason — no gate required',
  'remember': 'unavailable-with-reason — no gate required',
  'wasm_probe': 'unavailable-with-reason — no gate required',
  'wasm_disasm': 'unavailable-with-reason — no gate required',
  'js_trace': 'unavailable-with-reason — no gate required',
  'signer_trace': 'M4 observation expansion — unavailable-with-reason',
  'closure_read': 'M4 observation expansion — unavailable-with-reason',
  'whitebox_diff': 'M4/M5 — unavailable-with-reason',
  'run_node': 'xtrace-host/test/e1-host-exec.test.js (with policy)',
  'run_python': 'xtrace-host/test/e1-host-exec.test.js (with policy)',
  'npm_install': 'policy-gated default-deny — no standalone gate',
};

// ---- pure core, exported for the LIVE negative control (m-R2-2:
// the planted-absence control feeds a real host's negotiated surface
// with one registration deleted, instead of doctoring output JSON) ----
function buildRows(negotiated) {
  return negotiated.tools.map((t) => {
    const gate = GATES[t.name] || null;
    // gate provenance must point at a real file (or be an explicit
    // unavailable/placeholder note) — missing files fail the run
    if (gate && /\.cjs|\.js|\.py/.test(gate)) {
      const rel = gate.split(' ')[0];
      if (!fs.existsSync(path.join(ROOT, rel))) {
        throw new Error(`gate file missing for ${t.name}: ${rel}`);
      }
      // R1-4/M1: the named file must EXERCISE the tool — it has to
      // contain the tool name string (machine check, no prose
      // exemptions for available tools)
      const body = fs.readFileSync(path.join(ROOT, rel), 'utf8');
      const exercised = body.includes(t.name);
      if (t.state === 'available' && !exercised) {
        throw new Error(`gate does not exercise ${t.name}: ${rel} ` +
            `carries no reference to the tool`);
      }
      if (!exercised) {
        return {
          name: t.name, tier: t.tier, state: t.state,
          reason: t.reason || null,
          gate: `(no direct gate — gap: ${rel} never names the tool)`,
        };
      }
    }
    if (gate && t.state === 'available' &&
        /sibling|文案|—/.test(gate)) {
      throw new Error(`available tool ${t.name} has a prose gate ` +
          `exemption: "${gate}" — a real gate file is required`);
    }
    return {
      name: t.name, tier: t.tier, state: t.state,
      reason: t.reason || null, gate: gate || '(none — disclosed gap)',
    };
  });
}

// R1-4: the coverage check is against the INVENTORY set, not the
// hand-written GATES table — every inventory tool must appear as a
// matrix row (registered adapter or disclosed-unavailable). THROWS on
// any absent tool (the silent-absence kill switch).
function reconcileAgainstInventory(rows) {
  const inventory = parseInventory();
  const rowNames = new Set(rows.map((r) => r.name));
  const absent = [...inventory].filter((n) => !rowNames.has(n));
  if (absent.length) {
    throw new Error('inventory tools absent from the matrix (silent ' +
        'absence): ' + absent.join(','));
  }
  // internal primitives (matrix extras not in the inventory) are
  // listed separately, not mixed into the inventory count
  const internalPrimitives = rows.filter(
      (r) => !inventory.has(r.name)).map((r) => r.name);
  return { inventory, internalPrimitives };
}

async function main() {
  const exe = path.join(ROOT,
      'chromium/src/out/XTraceIntegration/ChromiumX.app/Contents/MacOS/Chromium');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'm3-matrix-'));
  const traceFile = path.join(root, 'traces', 'matrix', 'trace.ndjson');
  // R1-5(3): the matrix runs BOTH negotiation forms and reports them
  // side by side — the SHIPPING form (no hostExecPolicy: the GUI ships
  // none, so run_node/run_python are absent from the surface) is the
  // headline; the with-policy form documents what a policy unlocks.
  const FORMS = [
    { label: 'shipping:no-policy', policy: null },
    { label: 'with-policy', policy: { hostExecPolicy: {
        paths: { read: [], write: [path.join(root, 'out')] },
        network: { allow: [] }, deps: { npm: [] } } } },
  ];
  const formResults = [];
  const negotiated = await (async () => {
    let merged = null;
    for (const form of FORMS) {
      const h = await createHost({ executable: exe, workspaceRoot: root,
          traceFile, browserArgs: ['about:blank'], policy: form.policy });
      try {
        const caps = await h.capabilities();
        formResults.push({ label: form.label, counts: {
          available: caps.tools.filter((t) => t.state === 'available').length,
          degraded: caps.tools.filter((t) => t.state === 'degraded').length,
          unavailable: caps.tools.filter((t) => t.state === 'unavailable')
              .length },
          absent_under_this_form: FORMS.length > 1
              ? null : undefined });
        if (form.label === 'shipping:no-policy') {
          merged = caps;   // the headline form drives the rows
        }
      } finally {
        await h.close();
      }
    }
    return merged;
  })();
  try {
    void negotiated;
    const rows = buildRows(negotiated);
    const counts = {
      available: rows.filter((r) => r.state === 'available').length,
      degraded: rows.filter((r) => r.state === 'degraded').length,
      unavailable: rows.filter((r) => r.state === 'unavailable').length,
    };
    const missing = Object.keys(GATES).filter((name) =>
        !rows.some((r) => r.name === name));
    const { inventory, internalPrimitives } =
        reconcileAgainstInventory(rows);
    const matrix = { generated_ms: Date.now(), enhanced: negotiated.enhanced,
                     counts, missing_gates_for: missing,
                     inventory_total: inventory.size,
                     negotiation_forms: formResults,
                     internal_primitives: internalPrimitives,
                     tools: rows };
    const outDir = path.join(ROOT,
        'chromium/src/out/XTraceIntegration/validation');
    fs.mkdirSync(outDir, { recursive: true });
    const json = path.join(outDir, 'm3-capability-matrix.json');
    fs.writeFileSync(json, JSON.stringify(matrix, null, 1));
    const md = ['| tool | tier | state | reason | gate |',
                '| --- | --- | --- | --- | --- |',
                ...rows.map((r) => `| ${r.name} | ${r.tier} | ${r.state} | ` +
                    `${r.reason || ''} | ${r.gate || '(none — disclosed gap)'} |`)]
        .join('\n');
    const mdPath = path.join(ROOT, 'docs', 'm3-capability-matrix.md');
    const mdRows = rows.filter((r) => inventory.has(r.name));
    const mdTable = ['| tool | tier | state | reason | gate |',
                '| --- | --- | --- | --- | --- |',
                ...mdRows.map((r) => `| ${r.name} | ${r.tier} | ${r.state} | ` +
                    `${r.reason || ''} | ${r.gate || '(none — disclosed gap)'} |`)]
        .join('\n');
    const internalSection = internalPrimitives.length
        ? '\n## Host internal primitives (NOT inventory rows — excluded ' +
          'from the counts above)\n\n' +
          internalPrimitives.map((n) => '- ' + n).join('\n') + '\n'
        : '';
    fs.writeFileSync(mdPath,
        '# M3 capability matrix (AUTO-GENERATED — do not hand-edit)\n\n' +
        'Generated by scripts/m3-capability-matrix.js against the live ' +
        'composition root; rows reflect the SHIPPING form (no ' +
        'hostExecPolicy — see negotiation_forms in the JSON for the ' +
        'with-policy counts). Inventory rows: ' + inventory.size +
        ' (available=' + counts.available +
        ' degraded=' + counts.degraded +
        ' unavailable=' + counts.unavailable +
        '; internal primitives listed separately).\n\n' +
        mdTable + '\n' + internalSection);
    console.log(JSON.stringify({ counts, missing,
        json, md: mdPath }, null, 1));
    console.log('M3 CAPABILITY MATRIX: GENERATED (live host)');
  } finally {
    // hosts are closed per-form above; nothing leaks
  }
}

if (require.main === module) {
  main().then(() => process.exit(0)).catch((e) => {
    console.error('M3 CAPABILITY MATRIX: FAIL —', e.message);
    process.exit(1);
  });
}
// live-host negative control surface (r1-matrix m-R2-2)
module.exports = { parseInventory, buildRows, reconcileAgainstInventory };
