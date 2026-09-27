'use strict';
// M3-R1-4 gate: the matrix generator's coverage check must FAIL on a
// planted-missing registration — the negative control for the "silent
// absence" defect class. m-R2-2/M4-9: the plant is now made against a
// LIVE host's negotiated surface (one registration deleted before the
// check), not against doctored output JSON — the control drives the
// generator's own buildRows/reconcileAgainstInventory over the real
// composition root. Plus: the inventory parse is 66 tools and every
// unavailable row carries a reason.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..', '..');
const EXE = path.join(ROOT,
    'chromium/src/out/XTraceIntegration/ChromiumX.app/Contents/MacOS/Chromium');

function parseInventoryCount() {
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

test('R1-4: inventory parse = 66; shipped matrix rows cover it fully', () => {
  const inventory = parseInventoryCount();
  assert.equal(inventory.size, 66, 'inventory universe size');
  const matrix = JSON.parse(fs.readFileSync(path.join(ROOT,
      'chromium/src/out/XTraceIntegration/validation',
      'm3-capability-matrix.json'), 'utf8'));
  assert.equal(matrix.inventory_total, 66);
  const names = new Set(matrix.tools.map((t) => t.name));
  const absent = [...inventory].filter((n) => !names.has(n));
  assert.deepEqual(absent, [], 'every inventory tool appears');
  // unavailable rows MUST carry reasons (disclosed, not silent)
  const bare = matrix.tools.filter(
      (t) => t.state === 'unavailable' && !t.reason);
  assert.deepEqual(bare, [], 'unavailable rows carry reasons');
  // internal primitives excluded from inventory counts
  const internal = new Set(matrix.internal_primitives);
  for (const name of internal) {
    assert.ok(!inventory.has(name), `${name} is NOT an inventory tool`);
  }
});

test('R1-4 negative control (LIVE host): a registration deleted from ' +
    'the real negotiated surface flips the generator red',
    { timeout: 120000 }, async () => {
  const { createHost } = require('../src/host');
  const { buildRows, reconcileAgainstInventory } =
      require(path.join(ROOT, 'scripts/m3-capability-matrix.js'));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'm4-matrix-nc-'));
  const host = await createHost({ executable: EXE, workspaceRoot: root,
      traceFile: path.join(root, 'traces', 'nc', 'trace.ndjson'),
      browserArgs: ['about:blank'] });
  try {
    const caps = await host.capabilities();
    // positive arm: the untouched LIVE surface reconciles clean
    const clean = reconcileAgainstInventory(buildRows(caps));
    assert.equal(clean.inventory.size, 66);

    // plant: delete one registration from the LIVE caps (env_current —
    // the same family member the old doctored-JSON control dropped)
    const before = caps.tools.length;
    caps.tools = caps.tools.filter((t) => t.name !== 'env_current');
    assert.equal(caps.tools.length, before - 1, 'the plant really removed one');
    // the generator's OWN reconciliation must throw naming the tool —
    // silent absence is structurally impossible, proven on live input
    assert.throws(() => reconcileAgainstInventory(buildRows(caps)),
        (err) => /absent from the matrix/.test(err.message) &&
                 err.message.includes('env_current'),
        'the live-surface deletion flips the generator red');
  } finally {
    await host.close();
  }
});
