// P4-F4/B3 warm dual evidence (review A.3 basis): with a stable URL and
// one reusable profile, an ORDINARY environment must show real code-cache
// activity (a consume decision on the warm load), while the dedicated
// observer environment must show ONLY suppression — same source, same
// load pattern, different verified path. bytecode_version growth alone is
// never the oracle.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { once } = require('node:events');

const root = path.resolve(__dirname, '..');
const exe = path.resolve(root, 'chromium/src/out/XTraceIntegration/ChromiumX.app/Contents/MacOS/Chromium');
const validation = path.resolve(root, 'chromium/src/out/XTraceIntegration/validation');
const outDir = fs.mkdtempSync(path.join(validation, 'p4-b3-warm-'));
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('XTRACE_')));

// Stable URL + cacheable, non-trivial script (above the ~1KB code-cache
// threshold so production is even possible).
const scriptBody = 'function warm(n){let s=0;for(let i=0;i<n;i++)s+=(i%7);return s}\n'
  + Array.from({length: 40}, (_, i) => `function f${i}(x){return warm(x+${i})+${i}*x*x+x/3+Math.sqrt(x+${i})}`).join('\n')
  + '\nwindow.warmResult=f0(2000);window.reviewDone=true;';
// N4/R5: fixed expected value — f0(2000) = warm(2000) + 0 + 2000/3 + sqrt(2000).
const EXPECTED_WARM = (() => {
  let s = 0; for (let i = 0; i < 2000; i++) s += i % 7;
  return s + 2000 / 3 + Math.sqrt(2000);
})();
const server = http.createServer((req, res) => {
  if (req.url === '/warm.js') {
    res.writeHead(200, { 'Content-Type': 'application/javascript', 'Cache-Control': 'max-age=3600' });
    res.end(scriptBody);
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' });
  res.end('<!doctype html><script src="/warm.js"></script>');
});

class Pipe {
  constructor(child) {
    this.child = child; this.id = 0; this.pending = new Map(); let buf = Buffer.alloc(0);
    child.stdio[4].on('data', chunk => {
      buf = Buffer.concat([buf, chunk]); let n;
      while ((n = buf.indexOf(0)) >= 0) {
        const raw = buf.subarray(0, n).toString(); buf = buf.subarray(n + 1); if (!raw) continue;
        const msg = JSON.parse(raw), req = this.pending.get(msg.id);
        if (req) { clearTimeout(req.timer); this.pending.delete(msg.id); msg.error ? req.reject(new Error(JSON.stringify(msg.error))) : req.resolve(msg.result); }
      }
    });
  }
  send(method, params = {}, sessionId) {
    return new Promise((resolve, reject) => {
      const id = ++this.id; const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(method + ' timeout')); }, 30000);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdio[3].write(JSON.stringify({ id, method, params, sessionId }) + '\0');
    });
  }
}

async function runOnce(name, flags, loads) {
  const dir = path.join(outDir, name); fs.mkdirSync(dir);
  const trace = path.join(dir, 'trace.ndjson');
  const argv = ['--headless=new', '--remote-debugging-pipe', '--no-first-run', '--no-default-browser-check',
    '--disable-background-networking', '--disable-component-update', '--disable-sync',
    '--xtrace-enable', `--xtrace-file=${trace}`, '--xtrace-categories=reverse,fingerprint,internal',
    ...flags, `--user-data-dir=${path.join(dir, 'profile')}`, 'about:blank'];
  fs.writeFileSync(path.join(dir, 'command.json'), JSON.stringify({ exe, argv }, null, 2));
  const child = spawn(exe, argv, { env, stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });
  const exit = once(child, 'exit'), pipe = new Pipe(child);
  const url = `http://127.0.0.1:${server.address().port}/warm.html`;
  try {
    const { targetId } = await pipe.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await pipe.send('Target.attachToTarget', { targetId, flatten: true });
    await pipe.send('Page.enable', {}, sessionId);
    for (let i = 0; i < loads; i++) {
      await pipe.send('Page.navigate', { url }, sessionId);
      for (let k = 0; k < 60; k++) {
        const done = await pipe.send('Runtime.evaluate',
            { expression: 'window.reviewDone === true ? window.warmResult : false', returnByValue: true }, sessionId);
        if (done.result.value !== false) {
          // N4/R5: execution RESULT asserted (cache state must not break
          // JS semantics), at least on the final (warm) load.
          if (i === loads - 1) {
            const got = done.result.value;
            if (!(Math.abs(got - EXPECTED_WARM) < 1e-9)) {
              throw new Error(`${name}: warmResult ${got} != ${EXPECTED_WARM}`);
            }
          }
          break;
        }
        if (k === 59) throw new Error('page did not complete');
        await new Promise(r => setTimeout(r, 100));
      }
      await new Promise(r => setTimeout(r, 400));
    }
    await pipe.send('Browser.close');
  } finally {
    if (child.exitCode === null) { child.kill('SIGTERM'); await exit; }
  }
  // N4/R5: the FULL hardened validator gates each run (schema, single
  // capture, per-producer written == observed records).
  const v = spawnSync('python3', [path.join(root, 'scripts', 'validate_quiet.py'), trace],
      { encoding: 'utf8', timeout: 120000 });
  if (v.status !== 0) {
    fs.writeFileSync(path.join(dir, 'validator.txt'), (v.stdout || '') + (v.stderr || ''));
    throw new Error(`${name}: validator failed: ${(v.stderr || v.stdout || '').slice(0, 300)}`);
  }
  const events = fs.existsSync(trace) ? fs.readFileSync(trace, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
  const decisions = events.filter(e => e.api === 'XTraceCodeCache.compileOptions')
    .map(e => ({ outcome: (e.args && e.args[0] && e.args[0].outcome) || 'unknown' }));
  fs.writeFileSync(path.join(dir, 'decisions.json'), JSON.stringify(decisions, null, 2));
  return decisions;
}

(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  try {
    // 1) ORDINARY environment (no observer switch): two loads, one
    //    reusable profile — the warm load must show a real consume
    //    decision (cache produced on load 1, consumed on load 2).
    const normal = await runOnce('normal-env', ['--xtrace-causality=off'], 4);
    console.log('normal-env decisions:', JSON.stringify(normal));
    assert(normal.some(d => d.outcome === 'consume'),
        'ordinary environment shows no code-cache consume decision — dual evidence impossible');

    // 2) OBSERVER environment (the dedicated precise-mode launch env): the
    //    same loads must show ONLY suppression, never consume.
    const observer = await runOnce('observer-env',
        ['--xtrace-causality=sync', '--xtrace-ignition-observer', '--js-flags=--max-opt=0'], 4);
    console.log('observer-env decisions:', JSON.stringify(observer));
    assert(observer.some(d => d.outcome === 'suppressed-observer-env'),
        'observer environment shows no gate suppression — disable not wired');
    assert(observer.every(d => d.outcome !== 'consume' && d.outcome !== 'produce'),
        'observer environment performed code-cache activity — disable not effective');

    console.log('PASS: ordinary env consumes code cache; observer env suppresses it (A.3 dual evidence)');
    console.log(`Evidence: ${outDir}`);
  } finally { server.close(); }
})().catch(e => { console.error(e); server.close(); process.exitCode = 1; });
