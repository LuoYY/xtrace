'use strict';
// M3-R2 / D-M3-5: the tier contract is a SEMANTIC table (R2.3 ruling
// R1-C1): tier = a function of the ACTION's nature (read evidence vs
// state change vs host process). The inventory's 需确认 column is an
// frx-habit INPUT that can only TIGHTEN (是 ⇒ stateful holds); it can
// NEVER relax a state-changing tool to read. Every row cites its
// ruling; the master gate enforces the 是⇒stateful implication.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createHost } = require('../src/host');

const ROOT = path.resolve(__dirname, '..', '..');

// The semantic contract table. tiers: read = pure observation; stateful
// = changes browser/workspace/process state (per-call confirmation);
// host-exec = spawns host processes (policy-gated). Each row cites the
// ruling that set it.
const CONTRACT = {
  // --- reads (pure observation) ---
  'code_search': ['read', 'pure search over captured assets'],
  'scripts_list': ['read', 'enumeration'],
  'jsvmp_query': ['read', 'capture query'],
  'webapi_query': ['read', 'capture query'],
  'find_param_entry': ['read', 'cross-reference search'],
  'crypto_scan': ['read', 'static signature scan'],
  'skill_list': ['read', 'directory listing'],
  'skill_get': ['read', 'file read (paged)'],
  'skill_read_resource': ['read', 'file read (paged)'],
  'notes_get': ['read', 'notes file read'],
  'recall': ['read', 'ledger query'],
  'trace_summary': ['read', 'index summary'],
  'api_top': ['read', 'index aggregate'],
  'assets_list': ['read', 'index query'],
  'asset_read': ['read', 'asset content read'],
  'evidence_jump': ['read', 'line locate'],
  'page_elements': ['read', 'DOM enumeration (R2.2/B2 baseline)'],
  'page_scroll': ['read', 'viewport scroll only'],
  'page_screenshot': ['read', 'capture'],
  'page_info': ['read', 'page metadata'],
  'page_automation_scan': ['read', 'read-only probes'],
  'cookies': ['read', 'R2.3 ruling: READ SUBSET ONLY (Storage.getCookies); writes promote to stateful on landing'],
  'net_list': ['read', 'R1.3-B3 ruling: pure buffer query'],
  'net_get': ['read', 'fetched body read'],
  'jsvmp_status': ['read', 'status query'],
  'env_current': ['read', 'current env + instance rows'],
  'env_list': ['read', 'enumeration'],
  'env_status': ['read', 'status query'],
  'fs_list': ['read', 'directory listing'],
  'fs_read': ['read', 'file read (paged)'],
  'scripts_save': ['stateful', 'writes workspace file + owns a session'],
  'env_read_current_process_config': ['read', 'disclosed unavailable; read semantics'],
  'env_read_config': ['read', 'disclosed unavailable; read semantics'],
  'env_capture_fingerprint': ['read', 'disclosed unavailable; read semantics'],
  'env_import_fingerprint': ['read', 'disclosed unavailable'],
  // --- stateful (state changes: browser driving, workspace writes) ---
  'page_navigate': ['stateful', 'R1.3-B2: drives the browser'],
  'page_click': ['stateful', 'R1.3-B2: injects a click'],
  'page_type': ['stateful', 'R1.3-B2: injects input'],
  'page_eval': ['stateful', 'arbitrary page JS'],
  'hook_inject': ['stateful', 'page script injection'],
  'net_capture': ['stateful', 'opens a page + Network window'],
  'jsvmp_trace': ['stateful', 'capture lifecycle'],
  'webapi_trace': ['stateful', 'capture lifecycle'],
  'scripts_capture_all': ['stateful', 'capture lifecycle'],
  'env_create': ['stateful', 'creates profile dir'],
  'env_update': ['stateful', 'mutates env record'],
  'env_open': ['stateful', 'claims exclusivity + increments opens'],
  'env_close': ['stateful', 'releases exclusivity'],
  'env_delete': ['stateful', 'removes dir tree'],
  'fs_write': ['stateful', 'R2.3 R1-C1: workspace WRITE action'],
  'fs_mkdir': ['stateful', 'R2.3 R1-C1: workspace WRITE action'],
  'fs_copy': ['stateful', 'R2.3 R1-C1: workspace WRITE action'],
  'env_generate_fingerprint': ['stateful', 'disclosed unavailable; write semantics'],
  'env_import': ['stateful', 'disclosed unavailable; write semantics'],
  'env_write_current_process_config': ['stateful', 'disclosed unavailable; write semantics'],
  'env_reset_current_process_default': ['stateful', 'disclosed unavailable; write semantics'],
  'signer_trace': ['stateful', 'disclosed unavailable (M4); write-adjacent observation'],
  'closure_read': ['stateful', 'disclosed unavailable (M4)'],
  'whitebox_diff': ['stateful', 'disclosed unavailable (M4/M5)'],
  'notes_add': ['read', 'unavailable (frx) — tier moot until sources land'],
  'remember': ['read', 'unavailable (frx) — tier moot'],
  'wasm_probe': ['read', 'unavailable (frx) — tier moot'],
  'wasm_disasm': ['read', 'unavailable (frx) — tier moot'],
  'js_trace': ['read', 'unavailable (frx) — tier moot'],
};

function parseInventoryConfirm() {
  const text = fs.readFileSync(
      path.join(ROOT, 'docs/tool-inventory.md'), 'utf8');
  const map = {};
  for (const line of text.split('\n')) {
    const m = line.match(/^\|\s*`([a-z_0-9]+)`\s*\|[^|]+\|\s*(是|否)\s*\|/);
    if (m) {
      map[m[1]] = m[2];
    }
  }
  return map;
}

test('D-M3-5: tier == SEMANTIC contract (per-action nature, ruling-cited)', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'm3-d5-'));
  fs.mkdirSync(root, { recursive: true });
  const host = await createHost({ executable: '/nonexistent',
      workspaceRoot: root, skipBrowserLaunch: true });
  try {
    const mismatches = [];
    for (const adapter of host.adapters.all()) {
      const want = CONTRACT[adapter.name];
      if (!want) {
        continue;   // Host internal primitives are not contract rows
      }
      const tierName = want[0] === 'read' ? 'read-evidence'
          : want[0] === 'host-exec' ? 'host-exec' : 'stateful-control';
      if (adapter.tier !== tierName) {
        mismatches.push(`${adapter.name}: got ${adapter.tier}, ` +
            `contract says ${tierName} (${want[1]})`);
      }
    }
    assert.deepEqual(mismatches, []);
    // the fs write trio specifically
    for (const name of ['fs_write', 'fs_mkdir', 'fs_copy']) {
      const row = host.adapters.all().find((t) => t.name === name);
      assert.equal(row.tier, 'stateful-control', name);
    }
  } finally {
    host.close();
  }
});

test('D-M3-5 master gate: inventory 是 ⇒ stateful (never relaxed to read)', async () => {
  const inventory = parseInventoryConfirm();
  assert.ok(Object.keys(inventory).length >= 40);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'm3-d5b-'));
  fs.mkdirSync(root, { recursive: true });
  const host = await createHost({ executable: '/nonexistent',
      workspaceRoot: root, skipBrowserLaunch: true });
  try {
    // Ruled exceptions where 是 is relaxed BY A CITABLE RULING (each
    // cites its number; anything not listed here fails the gate)
    const RULED_EXCEPTIONS = {
      'cookies': 'R2.3 细判: read SUBSET only (Storage.getCookies); ' +
                 'writes promote to stateful on landing',
    };
    const relaxations = [];
    for (const adapter of host.adapters.all()) {
      if (inventory[adapter.name] === '是' &&
          adapter.tier !== 'stateful-control' &&
          adapter.tier !== 'host-exec' &&
          !RULED_EXCEPTIONS[adapter.name]) {
        relaxations.push(adapter.name + ' -> ' + adapter.tier);
      }
    }
    assert.deepEqual(relaxations, [],
        'the inventory column can only TIGHTEN: a 是 tool is never ' +
        'read-tier without a cited ruling (R2.3 R1-C1)');
  } finally {
    host.close();
  }
});

test('D-M3-5 red test: agent-origin fs_write parks at pending (zero writes)', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'm3-d5c-'));
  fs.mkdirSync(root, { recursive: true });
  const host = await createHost({ executable: '/nonexistent',
      workspaceRoot: root, skipBrowserLaunch: true });
  try {
    const exec = host.callTool('fs_write',
        { path: 'agent-try.txt', content: 'should not land' },
        { origin: 'agent', reason: 'D-M3-5 park red test' });
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(host.broker.pendingCount(), 1, 'agent fs_write parked');
    host.broker.resolveConfirmation(host.broker.pendingIds()[0], false);
    await assert.rejects(() => exec, /denied by user/);
    assert.ok(!fs.existsSync(path.join(root, 'agent-try.txt')),
        'no file landed — zero side effects');
    // ui origin with approval DOES execute (write lands)
    const out = await host.callTool('fs_write',
        { path: 'approved.txt', content: 'landed' },
        { origin: 'ui', reason: 'D-M3-5 approved write',
          basisHint: 'ui-direct-click' });
    assert.equal(out.bytes, 6);
    assert.ok(fs.existsSync(path.join(root, 'approved.txt')));
  } finally {
    host.close();
  }
});
