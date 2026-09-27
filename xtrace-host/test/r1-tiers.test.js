#!/usr/bin/env node
// M3-R1-2 gate: tier == the inventory's 需确认 column, machine-checked.
// Parses docs/tool-inventory.md §2 rows (tool | ... | 是/否 | ...) and
// asserts the composition root's registered tiers match: 是 →
// stateful-control, 否 → read-evidence. Exceptions must be EXPLICIT in
// this file (cookies: architect ruling R1.3-B2 — read subset stays
// read WITH the disclosure; net_list: R1.3-B3 ruling — pure buffer
// query is read). Any drift fails the gate.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createHost } = require('../src/host');

const ROOT = path.resolve(__dirname, '..', '..');

// Explicitly ruled exceptions (architect rulings, not drift):
//   cookies — read SUBSET stays read with the disclosure (writes
//             promote to stateful the moment they land)
//   net_list — pure buffer query per R1.3-B3
//   page_eval / hook_inetect / net_capture — already stateful
const EXPECT_TIER_OVERRIDES = {
  'cookies': 'read-evidence',        // R1.3-B2 细判（只读子集留 read）
  'net_list': 'read-evidence',       // R1.3-B3 纯查询裁定
  // PD1: host-exec tier is a SEPARATE class the inventory's 是/否
  // axis does not describe (policy-gated default deny)
  'npm_install': 'host-exec',
  'run_node': 'host-exec',
  'run_python': 'host-exec',
};

function parseInventoryConfirmColumn() {
  const text = fs.readFileSync(
      path.join(ROOT, 'docs/tool-inventory.md'), 'utf8');
  const map = {};
  for (const line of text.split('\n')) {
    const m = line.match(/^\|\s*`([a-z_0-9]+)`\s*\|[^|]+\|\s*(是|否)\s*\|/);
    if (m) {
      map[m[1]] = m[2] === '是' ? 'stateful-control' : 'read-evidence';
    }
  }
  return map;
}

test('R1-2: composition-root tiers == inventory 需确认 column', async () => {
  const inventory = parseInventoryConfirmColumn();
  assert.ok(Object.keys(inventory).length >= 40,
      'inventory rows parsed: ' + Object.keys(inventory).length);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'm3-r12-'));
  fs.mkdirSync(root, { recursive: true });
  const host = await createHost({ executable: '/nonexistent',
      workspaceRoot: root, skipBrowserLaunch: true });
  try {
    const mismatches = [];
    for (const adapter of host.adapters.all()) {
      const want = inventory[adapter.name] !== undefined
          ? inventory[adapter.name]
          : (EXPECT_TIER_OVERRIDES[adapter.name] || null);
      const override = EXPECT_TIER_OVERRIDES[adapter.name];
      const expected = override || want;
      if (expected === null) {
        continue;   // not in the inventory (Host internal primitives)
      }
      if (adapter.tier !== expected) {
        mismatches.push(`${adapter.name}: got ${adapter.tier}, ` +
            `expected ${expected}`);
      }
    }
    assert.deepEqual(mismatches, [],
        'tier drift vs inventory 需确认 column (overrides: ' +
        JSON.stringify(EXPECT_TIER_OVERRIDES) + ')');
    // the three named tools specifically (probe2 shape)
    for (const name of ['page_navigate', 'page_click', 'page_type']) {
      const row = host.adapters.all().find((t) => t.name === name);
      assert.equal(row.tier, 'stateful-control', name);
    }
    const cookies = host.adapters.all()
        .find((t) => t.name === 'cookies');
    assert.equal(cookies.tier, 'read-evidence');
    assert.match(cookies.degradedReason || cookies.reason || '',
        /READ SUBSET ONLY/);
  } finally {
    host.close();
  }
});
