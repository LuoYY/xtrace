'use strict';
// M3-E5: the frx track under the `not-transferred` judgment — the five
// frx-dependent D-group tools register as unavailable-with-reason on
// the negotiated surface, with NO weak substitute. The gate asserts
// the registration shape AND that the runtime refuses them.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createHost } = require('../src/host');

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'm3-e5-'));
}

test('E5: frx five unavailable-with-reason; runtime refuses; no weak substitute', async () => {
  const root = tmp();
  fs.mkdirSync(root, { recursive: true });
  const host = await createHost({ executable: '/nonexistent',
      workspaceRoot: root, skipBrowserLaunch: true });
  try {
    const FRX_FIVE = ['notes_add', 'remember', 'wasm_probe',
                      'wasm_disasm', 'js_trace'];
    // The five are UNAVAILABLE regardless of the browser shape; on a
    // browserless host the reason is the no-domain one (also correct —
    // enhanced-browser probes live in other gates). Assert the frx
    // reason via direct registration shape AND the negotiated row.
    for (const adapter of require('../src/adapters-frx-track')
        .createFrxTrackAdapters()) {
      assert.match(adapter.unavailableReason, /frx/i);
    }
    const caps = await host.capabilities();
    for (const name of FRX_FIVE) {
      const row = caps.tools.find((t) => t.name === name);
      assert.ok(row, `${name} registered (disclosed, not silently absent)`);
      assert.equal(row.state, 'unavailable', name);
      if (caps.enhanced) {
        assert.match(row.reason || '', /frx/i,
            `${name} reason names the frx dependency`);
      }
      // runtime refusal (never a weak substitute)
      const tool = host.tools.get(name);
      assert.ok(tool, `${name} tool object exists for refusal`);
      await assert.rejects(() => tool.run({}),
          /not migrated|frx/i,
          `${name} refuses at execution`);
    }
    // the model surface EXCLUDES all five
    const schemas = await host.toolSchemas();
    for (const name of FRX_FIVE) {
      assert.ok(!schemas.some((s) => s.name === name),
          `${name} not on the model tool surface`);
    }
  } finally {
    host.close();
  }
});
