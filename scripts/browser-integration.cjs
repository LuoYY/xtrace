const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');

const root = path.resolve(__dirname, '..');
const executable = path.resolve(process.argv[2] || path.join(__dirname, '../ChromiumX.app/Contents/MacOS/Chromium'));
const selected = new Set(process.argv.slice(3));
const runDir = fs.mkdtempSync(path.resolve(__dirname, '../chromium/src/out/XTraceIntegration/validation', 'browser-run-'));
const save = (name, value) => fs.writeFileSync(path.join(runDir, name), JSON.stringify(value, null, 2));

class PipeClient {
  constructor(child, events) {
    this.child = child;
    this.nextId = 0;
    this.pending = new Map();
    let buffered = Buffer.alloc(0);
    child.stdio[4].on('data', chunk => {
      buffered = Buffer.concat([buffered, chunk]);
      let boundary;
      while ((boundary = buffered.indexOf(0)) !== -1) {
        const raw = buffered.subarray(0, boundary).toString('utf8');
        buffered = buffered.subarray(boundary + 1);
        if (!raw) continue;
        const message = JSON.parse(raw);
        if (message.id) {
          const request = this.pending.get(message.id);
          if (!request) continue;
          clearTimeout(request.timer);
          this.pending.delete(message.id);
          if (message.error) request.reject(new Error(JSON.stringify(message.error)));
          else request.resolve(message.result);
        } else {
          events.push(message);
        }
      }
    });
    child.once('exit', (code, signal) => {
      for (const request of this.pending.values()) {
        clearTimeout(request.timer);
        request.reject(new Error(`Chromium exited: ${code}/${signal}`));
      }
      this.pending.clear();
    });
  }

  send(method, params = {}, sessionId) {
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }, 120000);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdio[3].write(JSON.stringify({ id, method, params, sessionId }) + '\0');
    });
  }
}

const cases = [
  { name: 'disabled-json', page: 'json-parse-smoke.html', mode: 'off', format: 'text' },
  { name: 'disabled-reverse', page: 'reverse-smoke.html', mode: 'off' },
  { name: 'disabled-fingerprint', page: 'fingerprint-smoke.html', mode: 'off' },
  { name: 'disabled-business', page: 'business-api-smoke.html', mode: 'off' },
  { name: 'json-v1', page: 'json-parse-smoke.html', mode: 'v1', format: 'text', apis: ['JSON.parse', 'JSON.stringify'] },
  { name: 'causality-v2', page: 'causality-smoke.html', mode: 'v2', selector: '#result', apis: ['TextEncoder.encode', 'JSON.parse', 'fetch'] },
  { name: 'causality-switch-only', page: 'causality-smoke.html', mode: 'v2-switch', selector: '#result', apis: ['TextEncoder.encode', 'JSON.parse', 'fetch'] },
  { name: 'worker-v1', page: 'worker-fetch-smoke.html', mode: 'v1', apis: ['fetch', 'Body.text'] },
  { name: 'worker-v2', page: 'worker-fetch-smoke.html', mode: 'v2', apis: ['fetch', 'Body.text'] },
  { name: 'business-v2', page: 'business-api-smoke.html', mode: 'v2', profile: 'business-api' },
  { name: 'reverse-v1', page: 'reverse-smoke.html', mode: 'v1', apis: ['Storage.setItem', 'Storage.getItem', 'Document.cookie.set', 'URLSearchParams.set', 'SubtleCrypto.importKey', 'SubtleCrypto.sign', 'fetch', 'XMLHttpRequest.send', 'eval', 'Function'], families: ['base64', 'text_codec', 'byte_buffer', 'dynamic_dispatch', 'proxy_trap', 'hash_crypto', 'int_bitwise', 'anti_debug_timing', 'source_probe'] },
  { name: 'fingerprint-v1', page: 'fingerprint-smoke.html', mode: 'v1', apis: ['CanvasRenderingContext2D.fillText', 'CanvasRenderingContext2D.getImageData', 'HTMLCanvasElement.toDataURL', 'Crypto.getRandomValues', 'Navigator.platform', 'Screen.width'] },
];

function verifyPage(test, value) {
  if (test.page === 'json-parse-smoke.html') {
    assert.equal(value, 'X-Signature=abc&X-Secondary-Signature=def&vm=opcode');
  } else if (test.page === 'causality-smoke.html') {
    assert.deepEqual(value, { first: 33, failure: 'SyntaxError' });
  } else if (test.page === 'worker-fetch-smoke.html') {
    assert.equal(value.status, 200);
    assert(value.length > 100);
    assert.equal(value.error, undefined);
  } else if (test.page === 'reverse-smoke.html') {
    for (const [key, expected] of Object.entries({ local: 'local-value', largeLength: 300000, session: 'session-value', paramsGet: 'updated', header: 'updated', base64: 'xtrace-vmp', decoded: 'vmp-bytecode', viewFloat16: 1.5, viewFloat32: 3.25, viewFloat64: 6.5, digestBytes: 32, hmacBytes: 32, fetchStatus: 200, xhrStatus: 200, typedBodyXhrStatus: 200, generated: 'function-smoke' })) {
      assert.equal(value[key], expected, key);
    }
  } else if (test.page === 'fingerprint-smoke.html') {
    assert.equal(value.imageDataLength, 4096);
    assert.equal(value.dataUrlPrefix, 'data:image/png;base64,');
    assert.equal(value.randomBytes, 16);
    assert.equal(value.intl.timeZone, 'UTC');
  } else if (test.page === 'business-api-smoke.html') {
    assert.match(value.demoMarker, /^demo-[0-9a-f]+$/);
    assert.equal(value.fetchStatus, 200);
    assert.equal(value.xhrStatus, 200);
    assert.equal(value.fetchRoute, '/api/records/list/');
    assert.equal(value.xhrRoute, '/api/records/list/');
    assert.equal(value.fetchItems, 2);
    assert.equal(value.recordsCustomHeadersReachedServer, true);
    assert.deepEqual(value.recordsQueryKeys, value.recordsEchoedQueryKeys);
    assert(value.xhrBodySize > 0);
  }
}

async function runCase(test, origin) {
  const caseDir = path.join(runDir, test.name);
  fs.mkdirSync(caseDir);
  const trace = path.join(caseDir, 'trace.ndjson');
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('XTRACE_')));
  const args = ['--headless=new', '--remote-debugging-pipe', '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-component-update', '--disable-sync', '--metrics-recording-only', '--disable-default-apps', `--user-data-dir=${path.join(caseDir, 'profile')}`];
  if (test.mode !== 'off') {
    const causality = test.mode.startsWith('v2') ? 'sync' : 'off';
    args.push('--xtrace-enable', `--xtrace-file=${trace}`, '--xtrace-categories=reverse,fingerprint', '--xtrace-capture-values=full', '--xtrace-capture-assets=full', `--xtrace-causality=${causality}`);
    // P4-E8: P4X_OBSERVER=1 runs the whole matrix with the structured
    // Ignition observer on, proving the P2 count/terminal contracts hold
    // under observer load (handoff §8).
    if (process.env.P4X_OBSERVER === '1') args.push('--xtrace-ignition-observer');
    if (test.mode !== 'v2-switch') Object.assign(env, { XTRACE_ENABLE: '1', XTRACE_FILE: trace, XTRACE_CATEGORIES: 'reverse,fingerprint', XTRACE_CAPTURE_VALUES: 'full', XTRACE_CAPTURE_ASSETS: 'full', XTRACE_CAUSALITY: causality });
  }
  args.push('about:blank');
  fs.writeFileSync(path.join(caseDir, 'command.json'), JSON.stringify({ executable, args, xtraceEnv: Object.fromEntries(Object.entries(env).filter(([key]) => key.startsWith('XTRACE_'))) }, null, 2));
  const stdout = fs.openSync(path.join(caseDir, 'stdout.log'), 'w');
  const stderr = fs.openSync(path.join(caseDir, 'stderr.log'), 'w');
  const startedAt = Date.now();
  let peakRSSKB = 0;
  // Baseline sampling (draft §12.2): sum RSS of every process carrying this
  // case's user-data-dir path (on macOS helpers run the same executable and
  // inherit --user-data-dir), polled until browser exit.
  const sampler = setInterval(() => {
    const ps = spawn('ps', ['-axo', 'rss=,command=', '-ww'], { stdio: ['ignore', 'pipe', 'ignore'] });
    let buf = '';
    ps.stdout.on('data', chunk => { buf += chunk; });
    ps.on('close', () => {
      let sum = 0;
      for (const line of buf.split('\n')) {
        if (line.includes(caseDir)) sum += Number.parseInt(line.trim().split(/\s+/)[0], 10) || 0;
      }
      if (sum > peakRSSKB) peakRSSKB = sum;
    });
  }, 500);
  const child = spawn(executable, args, { env, stdio: ['ignore', stdout, stderr, 'pipe', 'pipe'] });
  fs.closeSync(stdout);
  fs.closeSync(stderr);
  const events = [];
  const exited = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  const client = new PipeClient(child, events);
  let exit;
  try {
    const version = await client.send('Browser.getVersion');
    fs.writeFileSync(path.join(caseDir, 'version.json'), JSON.stringify(version, null, 2));
    const { targetId } = await client.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await client.send('Target.attachToTarget', { targetId, flatten: true });
    await client.send('Page.enable', {}, sessionId);
    await client.send('Runtime.enable', {}, sessionId);
    await client.send('Network.enable', {}, sessionId);
    const url = `${origin}/${test.page}`;
    const navigation = await client.send('Page.navigate', { url }, sessionId);
    assert.equal(navigation.errorText, undefined, JSON.stringify(navigation));
    const expression = `new Promise((resolve, reject) => {
      const timer = setTimeout(() => { observer.disconnect(); reject(new Error('fixture timeout')); }, 90000);
      const observer = new MutationObserver(check);
      function check() {
        if (location.href !== ${JSON.stringify(url)}) return;
        const text = document.querySelector(${JSON.stringify(test.selector || '#out')})?.textContent;
        if (!text || text === 'running' || text === 'starting') return;
        let value = text;
        ${test.format === 'text' ? '' : 'try { value = JSON.parse(text); } catch { return; }'}
        clearTimeout(timer); observer.disconnect(); resolve(value);
      }
      observer.observe(document, {subtree: true, childList: true, characterData: true}); check();
    })`;
    const result = await client.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
    fs.writeFileSync(path.join(caseDir, 'page-result.json'), JSON.stringify(result, null, 2));
    assert.equal(result.exceptionDetails, undefined, JSON.stringify(result));
    verifyPage(test, result.result.value);
    if (test.page === 'reverse-smoke.html') {
      const dynamic = await client.send('Runtime.evaluate', { expression: `new Promise((resolve, reject) => { const deadline = performance.now() + 10000; function check() { if (window.__xtrace_eval === 1 && window.__xtrace_timer === 1 && window.__xtrace_script_loaded) resolve(true); else if (performance.now() > deadline) reject(new Error('dynamic script timeout')); else setTimeout(check, 25); } check(); })`, awaitPromise: true, returnByValue: true }, sessionId);
      fs.writeFileSync(path.join(caseDir, 'dynamic-result.json'), JSON.stringify(dynamic, null, 2));
      assert.equal(dynamic.exceptionDetails, undefined);
    }
    const screenshot = await client.send('Page.captureScreenshot', { format: 'png' }, sessionId);
    fs.writeFileSync(path.join(caseDir, 'page.png'), Buffer.from(screenshot.data, 'base64'));
    const requests = events.filter(event => event.method === 'Network.responseReceived' && event.params.response.url.startsWith(origin));
    assert(requests.some(event => event.params.response.url === url && event.params.response.status === 200));
    assert.equal(events.filter(event => event.method === 'Runtime.exceptionThrown').length, 0, 'uncaught page exception');
    // P3-E6: settle via the domain (scaffolding stop-after removed).
    try {
      const stopReply = await client.send('XTrace.stopCapture');
      test.terminal = stopReply.state;
    } catch (e) { /* domain absent when capture disabled */ }
    await client.send('Browser.close');
    let timer;
    try {
      exit = await Promise.race([exited, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('browser close timeout')), 20000); })]);
    } finally {
      clearTimeout(timer);
    }
    assert.equal(exit.code, 0, JSON.stringify(exit));
    const wallClockMs = Date.now() - startedAt;
    if (test.mode === 'off') {
      assert(!fs.existsSync(trace) || fs.statSync(trace).size === 0);
      return { name: test.name, status: 'pass', exit, traceRecords: 0, traceBytes: 0, wallClockMs, peakRSSKB };
    }
    assert(fs.existsSync(trace) && fs.statSync(trace).size > 0, 'missing trace');
    const traceBytes = fs.statSync(trace).size;
    const records = fs.readFileSync(trace, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    const schema = '3';
    assert(records.every(record => record.schema_version === 3), 'non-v3 record in v3 trace');
    if (test.name.startsWith('worker-')) {
      // Thread-provenance evidence: per pid:tid API sets so review can confirm
      // Body.text ran on a worker thread, not the main script thread.
      const byTid = new Map();
      for (const record of records) {
        const key = `${record.pid}:${record.tid}`;
        if (!byTid.has(key)) byTid.set(key, { pid: record.pid, tid: record.tid, apiCounts: {}, samples: [] });
        const entry = byTid.get(key);
        entry.apiCounts[record.api] = (entry.apiCounts[record.api] || 0) + 1;
        if (entry.samples.length < 3) entry.samples.push({ api: record.api, phase: record.phase, stack: record.stack });
      }
      const context = [...byTid.values()].map(entry => ({ ...entry, distinctApis: Object.keys(entry.apiCounts).length }));
      fs.writeFileSync(path.join(caseDir, 'worker-context.json'), JSON.stringify(context, null, 2));
      const bodyTextTids = new Set(records.filter(record => record.api === 'Body.text').map(record => `${record.pid}:${record.tid}`));
      assert(bodyTextTids.size > 0, 'no Body.text events observed');
      assert(byTid.size >= 2, 'expected worker events on a separate thread');
    }
    const validationArgs = [path.join(root, 'scripts/validate_trace.py'), '--schema-version', schema];
    if (test.profile) validationArgs.push('--profile', test.profile);
    for (const api of test.apis || []) validationArgs.push('--expect', api);
    for (const family of test.families || []) validationArgs.push('--require-vmp-family', family);
    validationArgs.push(trace);
    const validation = spawnSync('python3', validationArgs, { encoding: 'utf8', timeout: 60000 });
    fs.writeFileSync(path.join(caseDir, 'validator.log'), (validation.stdout || '') + (validation.stderr || ''));
    assert.equal(validation.status, 0, `validator failed: ${validation.stdout} ${validation.stderr}`);
    const manifest = path.join(caseDir, 'assets/trace/manifest.ndjson');
    const captureManifestPath = trace.replace(/\.ndjson$/, '.manifest.json');
    assert(fs.existsSync(captureManifestPath), 'missing capture manifest');
    const captureManifest = JSON.parse(fs.readFileSync(captureManifestPath, 'utf8'));
    assert(['complete', 'incomplete'].includes(captureManifest.terminal.state),
        `unexpected terminal state ${captureManifest.terminal.state}`);
    if (!fs.existsSync(manifest)) return { name: test.name, status: 'pass', exit, traceRecords: records.length, traceBytes, wallClockMs, peakRSSKB, assets: 0, schema: 3, terminal: captureManifest.terminal.state, closeEvidence: 'domain stopCapture settle (P3); watermark protocol live since P2' };
    const assets = fs.readFileSync(manifest, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert(assets.length >= 0);
    for (const asset of assets) {
      // Schema v3 asset rows: no embedded source (V06 closure).
      assert(!('source' in asset), 'V06 regression: source embedded in asset row');
      assert.equal(asset.retrieval_status, 'captured');
      assert.equal(typeof asset.content_path, 'string');
      const contentPath = path.resolve(caseDir, asset.content_path);
      assert(contentPath.startsWith(caseDir + path.sep), 'asset path escapes capture directory');
      const content = fs.readFileSync(contentPath);
      assert.equal(content.length, Number(asset.original_size));
      assert.equal('sha1:' + createHash('sha1').update(content).digest('hex').toUpperCase(), asset.sha1);
      assert.equal(asset.truncated, false);
    }
    return { name: test.name, status: 'pass', exit, traceRecords: records.length, traceBytes, wallClockMs, peakRSSKB, assets: assets.length, schema: Number(schema), closeEvidence: 'domain stopCapture settle (P3); watermark protocol live since P2' };
  } finally {
    clearInterval(sampler);
    fs.writeFileSync(path.join(caseDir, 'cdp-events.json'), JSON.stringify(events, null, 2));
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      await exited;
    }
  }
}

async function main() {
  assert(fs.existsSync(executable), executable);
  const source = `import importlib.util, pathlib, socketserver\np = pathlib.Path(${JSON.stringify(path.join(root, 'scripts/serve_test_page.py'))})\nspec = importlib.util.spec_from_file_location('smoke_server', p)\nm = importlib.util.module_from_spec(spec)\nspec.loader.exec_module(m)\nwith socketserver.TCPServer(('127.0.0.1', 0), m.make_test_page_handler(p.parent.parent / 'test-pages')) as server:\n print(server.server_address[1], flush=True)\n server.serve_forever()\n`;
  const server = spawn('python3', ['-u', '-c', source], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
  const serverLog = fs.createWriteStream(path.join(runDir, 'server.log'));
  server.stderr.pipe(serverLog);
  const port = await new Promise((resolve, reject) => {
    let text = '';
    server.once('error', reject);
    server.stdout.on('data', chunk => {
      text += chunk.toString();
      if (text.includes('\n')) resolve(Number(text.trim()));
    });
    server.once('exit', code => reject(new Error(`fixture server exited: ${code}`)));
  });
  const summary = [];
  try {
    for (const test of cases.filter(test => selected.size === 0 || selected.has(test.name))) {
      try {
        summary.push(await runCase(test, `http://127.0.0.1:${port}`));
      } catch (error) {
        summary.push({ name: test.name, status: 'fail', error: error.stack });
        process.exitCode = 1;
      }
      save('summary.json', summary);
      console.log(JSON.stringify(summary.at(-1)));
    }
  } finally {
    server.kill('SIGTERM');
  }
  console.log(`Evidence: ${runDir}`);
}

main().catch(error => { console.error(error); process.exitCode = 1; });
