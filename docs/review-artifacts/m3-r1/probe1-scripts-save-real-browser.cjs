// M3 review probe: does scripts_save work on a REAL browser?
// (the e2 gate's happy path used a scripted fake host)
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const root = path.resolve(__dirname, '..', '..', '..');
const { createHost } = require(path.join(root, 'xtrace-host/src/host'));
const { spawn } = require('node:child_process');
const exe = path.join(root, 'chromium/src/out/XTraceIntegration/ChromiumX.app/Contents/MacOS/Chromium');

const source = `import importlib.util, pathlib, socketserver
p = pathlib.Path(${JSON.stringify(path.join(root, 'scripts/serve_test_page.py'))})
spec = importlib.util.spec_from_file_location('s', p)
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
with socketserver.TCPServer(('127.0.0.1', 0), m.make_test_page_handler(p.parent.parent / 'test-pages')) as server:
 print(server.server_address[1], flush=True)
 server.serve_forever()
`;
const server = spawn('python3', ['-u', '-c', source], { stdio: ['ignore', 'pipe', 'ignore'] });

(async () => {
  const port = await new Promise(r => { let t=''; server.stdout.on('data', c => { t+=c; if (t.includes('\n')) r(Number(t.trim())); }); });
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'm3-ssave-'));
  const host = await createHost({ executable: exe, workspaceRoot: ws,
    traceFile: path.join(ws, 'traces', 'ss', 'trace.ndjson'), browserArgs: ['about:blank'] });
  const out = {};
  try {
    const { targetId } = await host.send('Target.createTarget',
      { url: `http://127.0.0.1:${port}/crypto-sign-smoke.html` });
    const { sessionId } = await host.send('Target.attachToTarget', { targetId, flatten: true });
    const scripts = [];
    host.onEvent((m) => { if (m.method === 'Debugger.scriptParsed') scripts.push(m.params); });
    await host.send('Debugger.enable', {}, sessionId);
    await new Promise(r => setTimeout(r, 1200));
    out.scriptIds_seen = scripts.length;
    const target = scripts.find(s => s.url && s.url.includes('crypto-sign')) || scripts[0];
    out.picked = target && { scriptId: target.scriptId, url: target.url, len: target.length };
    // call the tool through the composition root, as the product does
    try {
      const r = await host.callTool('scripts_save', { script_id: target.scriptId },
        { origin: 'ui', reason: 'probe scripts_save happy path', basisHint: 'ui-direct-click' });
      out.tool_result = { saved: r.saved, bytes: r.integrity && r.integrity.bytes };
    } catch (e) {
      out.tool_result = { threw: String(e.message).slice(0, 200) };
    }
    // control: same call WITH the sessionId
    try {
      const direct = await host.send('Debugger.getScriptSource',
        { scriptId: target.scriptId }, sessionId);
      out.direct_with_session = { got: typeof direct, bytes: direct && direct.scriptSource ? direct.scriptSource.length : null };
    } catch (e) {
      out.direct_with_session = { threw: String(e.message).slice(0, 200) };
    }
    await host.send('Target.closeTarget', { targetId }).catch(() => {});
  } catch (e) { out.error = String(e.stack).slice(0, 300); }
  await host.close(); server.kill();
  console.log(JSON.stringify(out, null, 1));
})().catch(e => { console.error('PROBE ERROR', e); server.kill(); process.exit(1); });
