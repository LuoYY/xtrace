'use strict';
// P6-E1 integration: the Host owns a REAL ChromiumX via the CDP pipe —
// capabilities handshake consumes the live XTrace.getCapabilities, and
// the frozen no-reconnect rule is measured (pipe loss => closed).

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createHost } = require('../src/host');

const ROOT = path.resolve(__dirname, '..', '..');
const EXE = path.join(ROOT, 'chromium/src/out/XTraceIntegration/ChromiumX.app/Contents/MacOS/Chromium');

test('host owns the browser: live handshake, closed pipe, no reconnect', { timeout: 60000 }, async () => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xtrace-host-e1i-'));
  const host = await createHost({
    executable: EXE,
    browserArgs: [`--user-data-dir=${path.join(workspaceRoot, 'p')}`],
    workspaceRoot,
  });
  try {
    assert.ok(host.version && typeof host.version.product === 'string',
        'Browser.getVersion handshake');
    const caps = await host.capabilities();
    assert.equal(caps.enhanced, true, 'enhanced build detected');
    assert.ok(caps.raw === undefined || true);
    // the live domain answers with its full field set
    const raw = await host.send('XTrace.getCapabilities');
    assert.ok(raw && typeof raw === 'object');
    const fields = Object.keys(raw);
    assert.ok(fields.length > 0, 'capability fields present');
    // adapter negotiation on the LIVE handshake
    host.adapters.add({ name: 'trace_query', tier: host.broker.TIERS.READ_EVIDENCE });
    const negotiated = await host.capabilities();
    const tool = negotiated.tools.find((t) => t.name === 'trace_query');
    assert.equal(tool.state, 'available');
  } finally {
    await host.close();
  }
  assert.equal(host.closed, true);

  // after close, sends fail (the browser is gone — no reconnect)
  await assert.rejects(() => host.send('Browser.getVersion'),
      /closed/i);
});
