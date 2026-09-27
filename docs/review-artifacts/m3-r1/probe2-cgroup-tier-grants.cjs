// M3 review probe: do agent-origin page_navigate/page_click/cookies get
// a SILENT session grant (no human confirmation) despite the frozen
// inventory's 需确认=是 for these tools?
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const root = path.resolve(__dirname, '..', '..', '..');
const { createHost } = require(path.join(root, 'xtrace-host/src/host'));
(async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'm3-tier-'));
  const host = await createHost({ executable: '/nonexistent', workspaceRoot: ws,
    skipBrowserLaunch: true });
  const out = {};
  for (const tool of ['page_navigate', 'page_click', 'page_type', 'cookies',
                      'page_eval', 'net_capture', 'jsvmp_trace']) {
    try {
      await host.callTool(tool, { url: 'https://example.invalid/' },
        { origin: 'agent', reason: 'M3 review tier probe' });
      out[tool] = 'EXECUTED (unexpected without browser)';
    } catch (e) {
      out[tool] = /denied|closed|no live browser/.test(String(e.message))
          ? String(e.message).slice(0, 60) : 'threw: ' + String(e.message).slice(0, 60);
    }
  }
  const ledger = fs.readFileSync(host.broker.ledgerPath, 'utf8').trim().split('\n')
      .map(l => JSON.parse(l));
  out.ledger = ledger.map(r => `${r.tool}:${r.origin}:${r.decision}:${r.basis || r.reason || ''}`);
  await host.close();
  console.log(JSON.stringify(out, null, 1));
})().catch(e => { console.error('PROBE ERROR', e); process.exit(1); });
