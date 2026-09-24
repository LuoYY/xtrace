// P55-E6: local re-capture of ONE corpus site with the current binary
// (D1 metadata assets flow). Recipe per analysis/corpus-capture/README:
// local http server serving the corpus dir, wrapper page, observer +
// max-opt=0, dead-proxy guard (never contacts the origin). NO third
// party is contacted; scripts were verified origin-free at capture.
const assert = require('node:assert/strict');
const fs = require('node:fs'); const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const root = path.resolve(__dirname, '..');
const { CdpPipe, closeBrowser } = require(path.join(root, 'scripts/lib/cdp-pipe.cjs'));
const exe = path.join(root, 'chromium/src/out/XTraceIntegration/ChromiumX.app/Contents/MacOS/Chromium');
const site = process.argv[2] || 'xj1';
const seconds = Number(process.argv[3] || 14);
const runDir = fs.mkdtempSync(path.join(root, 'chromium/src/out/XTraceIntegration/validation', `p55-e6-${site}-`));
const trace = path.join(runDir, 'trace.ndjson');
const corpus = path.join(root, 'analysis/corpus-capture');
const server = spawn('python3', ['-m', 'http.server', '8799', '--directory', corpus],
  { stdio: ['ignore', 'ignore', 'ignore'] });
(async () => {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('XTRACE_')));
  const argv = ['--headless=new','--remote-debugging-pipe','--no-first-run',
    `--user-data-dir=${path.join(runDir,'p')}`,
    '--xtrace-enable', `--xtrace-file=${trace}`,
    '--xtrace-categories=reverse', '--xtrace-causality=sync',
    '--xtrace-ignition-observer', '--js-flags=--max-opt=0',
    '--proxy-server=http://127.0.0.1:9', '--proxy-bypass-list=127.0.0.1',
    'about:blank'];
  const fd = fs.openSync(path.join(runDir, 'stderr.log'), 'w');
  const child = spawn(exe, argv, { env, cwd: root, stdio: ['ignore','ignore',fd,'pipe','pipe'] });
  fs.closeSync(fd);
  const events = [];
  const exit = once(child, 'exit');
  const c = new CdpPipe(child, { timeoutMs: 60000, onEvent: e => events.push(e) });
  try {
    const { targetId } = await c.send('Target.createTarget',
      { url: `http://127.0.0.1:8799/wrapper-${site}.html` });
    const { sessionId } = await c.send('Target.attachToTarget', { targetId, flatten: true });
    await c.send('Page.enable', {}, sessionId);
    await new Promise(r => setTimeout(r, seconds * 1000));
    const stop = await c.send('XTrace.stopCapture');
    await c.send('Browser.close');
    console.log(JSON.stringify({ site, terminal: stop.state, dir: path.basename(runDir) }));
  } catch (e) { console.error(e.stack); }
  const ended = await Promise.race([exit, new Promise(r => setTimeout(r, 4000))]);
  if (!ended) await closeBrowser(child, { graceMs: 3000, killMs: 3000 });
  server.kill();
  assert(fs.existsSync(trace), 'no trace written');
  console.log(`trace: ${trace}`);
})().catch(e => { console.error(e); server.kill(); process.exit(1); });
