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

// gate provenance: tool -> shipped gate that exercises it (the
// generator asserts each named file exists; empty = unexercised, which
// the matrix discloses as a gap rather than hiding)
const GATES = {
  'trace_query': 'xtrace-host/test/r1-core.test.js',
  'trace_summary': 'xtrace-host/test/r1-core.test.js',
  'api_top': 'xtrace-host/test/r1-core.test.js (indirect via summary)',
  'assets_list': 'xtrace-host/test/r1-adapters.test.js',
  'asset_read': 'xtrace-host/test/r1-adapters.test.js',
  'code_search': 'xtrace-host/test/r1-adapters.test.js',
  'scripts_list': 'xtrace-host/test/r1-adapters.test.js',
  'jsvmp_query': 'xtrace-host/test/r1-adapters.test.js',
  'webapi_query': 'xtrace-host/test/r1-adapters.test.js',
  'find_param_entry': 'xtrace-host/test/r1-adapters.test.js',
  'crypto_scan': 'xtrace-host/test/r1-adapters.test.js',
  'evidence_jump': 'xtrace-host/test/r1-adapters.test.js',
  'notes_get': 'xtrace-host/test/r1-core.test.js (via skill gates)',
  'recall': 'xtrace-host/test/r1-core.test.js (broker read rows)',
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
  'jsvmp_status': 'scripts/p6-e5-ui-scenarios.cjs (agent probe)',
  'webapi_trace': 'xtrace-host/test/r1-adapters.test.js (start path)',
  'scripts_capture_all': '— (start-path sibling; exercised via E5 start)',
  'env_create': 'xtrace-host/test/r1-core.test.js',
  'env_list': 'xtrace-host/test/r1-core.test.js',
  'env_status': 'xtrace-host/test/r1-core.test.js',
  'env_update': 'xtrace-host/test/r1-core.test.js',
  'env_open': 'xtrace-host/test/r1-core.test.js',
  'env_close': 'xtrace-host/test/r1-core.test.js',
  'env_delete': 'xtrace-host/test/r1-core.test.js',
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
  'fs_mkdir': 'xtrace-host/test/e2-dgroup.test.js',
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

async function main() {
  const exe = path.join(ROOT,
      'chromium/src/out/XTraceIntegration/ChromiumX.app/Contents/MacOS/Chromium');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'm3-matrix-'));
  const traceFile = path.join(root, 'traces', 'matrix', 'trace.ndjson');
  const host = await createHost({ executable: exe, workspaceRoot: root,
      traceFile, browserArgs: ['about:blank'],
      // M3-E1: the executors ride the surface only under a policy —
      // the matrix negotiates WITH one (that is the shipped shape the
      // gate map references).
      policy: { hostExecPolicy: {
        paths: { read: [], write: [path.join(root, 'out')] },
        network: { allow: [] }, deps: { npm: [] } } } });
  try {
    const negotiated = await host.capabilities();
    const rows = negotiated.tools.map((t) => {
      const gate = GATES[t.name] || null;
      // gate provenance must point at a real file (or be an explicit
      // unavailable/placeholder note) — missing files fail the run
      if (gate && /\.cjs|\.js|\.py/.test(gate)) {
        const rel = gate.split(' ')[0];
        if (!fs.existsSync(path.join(ROOT, rel))) {
          throw new Error(`gate file missing for ${t.name}: ${rel}`);
        }
      }
      return {
        name: t.name, tier: t.tier, state: t.state,
        reason: t.reason || null, gate,
      };
    });
    const counts = {
      available: rows.filter((r) => r.state === 'available').length,
      degraded: rows.filter((r) => r.state === 'degraded').length,
      unavailable: rows.filter((r) => r.state === 'unavailable').length,
    };
    const missing = Object.keys(GATES).filter((name) =>
        !rows.some((r) => r.name === name));
    const matrix = { generated_ms: Date.now(), enhanced: negotiated.enhanced,
                     counts, missing_gates_for: missing, tools: rows };
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
    fs.writeFileSync(mdPath,
        '# M3 capability matrix (AUTO-GENERATED — do not hand-edit)\n\n' +
        `Generated by scripts/m3-capability-matrix.js against the live ` +
        `composition root. Counts: available=${counts.available} ` +
        `degraded=${counts.degraded} unavailable=${counts.unavailable}.\n\n` +
        md + '\n');
    console.log(JSON.stringify({ counts, missing,
        json, md: mdPath }, null, 1));
    // consistency: every inventory A-13 + B-5+7 first-batch tool present
    const required = [
      // A-group inventory 13
      'code_search', 'scripts_list', 'jsvmp_query', 'webapi_query',
      'find_param_entry', 'crypto_scan', 'jsvmp_split_dispatcher',
      'jsvmp_disassemble', 'skill_list', 'skill_get', 'skill_read_resource',
      'notes_get', 'recall',
      // B-group five + env seven
      'jsvmp_trace', 'jsvmp_status', 'webapi_trace', 'scripts_capture_all',
      'env_create', 'env_list', 'env_status', 'env_update', 'env_open',
      'env_close', 'env_delete',
      // M5-disclosed four
      'env_current_process', 'env_read_current_process_config',
      'env_write_current_process_config', 'env_reset_current_process_default',
      // M3 C-group 14 (IN; signer_trace/closure_read OUT to M4)
      'page_navigate', 'page_elements', 'page_click', 'page_type',
      'page_scroll', 'page_screenshot', 'page_info', 'page_eval',
      'hook_inject', 'cookies', 'net_capture', 'net_list', 'net_get',
      'page_automation_scan',
      // M3 D-group native six + scripts_save
      'fs_list', 'fs_read', 'fs_write', 'fs_mkdir', 'fs_copy',
      'scripts_save',
      // M3 D-group frx track five (not-transferred -> unavailable)
      'notes_add', 'remember', 'wasm_probe', 'wasm_disasm', 'js_trace',
      // M4/M5 OUT (disclosed unavailable)
      'signer_trace', 'closure_read', 'whitebox_diff',
      // M3-E1 executors (unavailable without a policy object)
      'run_node', 'run_python',
      // M3 policy gate (default-deny)
      'npm_install',
    ];
    const absent = required.filter((n) => !rows.some((r) => r.name === n));
    if (absent.length) {
      throw new Error(`required tools missing from matrix: ${absent}`);
    }
    if (missing.length) {
      console.error('WARNING: gate-map entries with no tool: ' + missing);
    }
    console.log('M3 CAPABILITY MATRIX: GENERATED (live host)');
  } finally {
    await host.close();
  }
}

main().then(() => process.exit(0)).catch((e) => {
  console.error('M3 CAPABILITY MATRIX: FAIL —', e.message);
  process.exit(1);
});
