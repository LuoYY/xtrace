// P2-E7 fault injection: each scenario asserts the manifest terminal state
// and count-conservation behavior required by the handoff table. No
// scenario may report a fabricated terminal state.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '../../../../..');
const executable = path.resolve(path.join(__dirname, '../chromium/src/out/XTraceIntegration/ChromiumX.app/Contents/MacOS/Chromium'));
const runDir = fs.mkdtempSync(path.resolve(__dirname, '../chromium/src/out/XTraceIntegration/validation', 'p2-fault-'));
const save = (n, v) => fs.writeFileSync(path.join(runDir, n), JSON.stringify(v, null, 2));

class PipeClient {
  constructor(child) { this.child = child; this.nextId = 0; this.pending = new Map(); let buffered = Buffer.alloc(0);
    child.stdio[4].on('data', chunk => { buffered = Buffer.concat([buffered, chunk]); let boundary;
      while ((boundary = buffered.indexOf(0)) !== -1) { const raw = buffered.subarray(0, boundary).toString('utf8'); buffered = buffered.subarray(boundary + 1); if (!raw) continue;
        const message = JSON.parse(raw); if (message.id) { const request = this.pending.get(message.id); if (!request) continue; this.pending.delete(message.id);
          if (message.error) request.reject(new Error(JSON.stringify(message.error))); else request.resolve(message.result); } } }); }
  send(method, params = {}, sessionId) { return new Promise((resolve, reject) => { const id = ++this.nextId;
    const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 60000);
    this.pending.set(id, { resolve, reject, timer });
    this.child.stdio[3].write(JSON.stringify({ id, method, params, sessionId }) + '\0'); }); }
}

async function launch(caseDir, extraArgs) {
  const trace = path.join(caseDir, 'trace.ndjson');
  const args = ['--headless=new', '--remote-debugging-pipe', '--no-first-run', '--no-default-browser-check',
    '--disable-background-networking', '--disable-component-update', '--disable-sync',
    '--xtrace-enable', `--xtrace-file=${trace}`, '--xtrace-categories=reverse,fingerprint',
    '--xtrace-capture-values=full', '--xtrace-capture-assets=full', '--xtrace-causality=sync',
    ...extraArgs,
    `--user-data-dir=${path.join(caseDir, 'profile')}`, 'about:blank'];
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('XTRACE_')));
  const stderr = fs.openSync(path.join(caseDir, 'stderr.log'), 'w');
  const child = spawn(executable, args, { env, stdio: ['ignore', 'ignore', stderr, 'pipe', 'pipe'] });
  fs.closeSync(stderr);
  return { child, trace, client: new PipeClient(child) };
}

function manifestFor(trace) {
  return JSON.parse(fs.readFileSync(trace.replace(/\.ndjson$/, '.manifest.json'), 'utf8'));
}

function assertEquations(manifest) {
  for (const p of manifest.producers) {
    if (!p.watermark.received) continue;
    assert.equal(Number(p.eligible), Number(p.enqueued) + Number(p.dropped), `${p.producer_id} eligible eq`);
    assert.equal(Number(p.enqueued), Number(p.accepted), `${p.producer_id} enqueued eq`);
    assert.equal(Number(p.accepted), Number(p.written) + Number(p.failed), `${p.producer_id} accepted eq`);
  }
}

async function openPage(client, url) {
  const { targetId } = await client.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await client.send('Target.attachToTarget', { targetId, flatten: true });
  await client.send('Page.enable', {}, sessionId);
  const navigation = await client.send('Page.navigate', { url }, sessionId);
  assert.equal(navigation.errorText, undefined);
  return { targetId, sessionId };
}

const source = `import importlib.util, pathlib, socketserver\np = pathlib.Path(${JSON.stringify(path.join(root, 'scripts/serve_test_page.py'))})\nspec = importlib.util.spec_from_file_location('fault_server', p)\nm = importlib.util.module_from_spec(spec)\nspec.loader.exec_module(m)\nwith socketserver.TCPServer(('127.0.0.1', 0), m.make_test_page_handler(p.parent.parent / 'test-pages')) as server:\n print(server.server_address[1], flush=True)\n server.serve_forever()\n`;
const server = spawn('python3', ['-u', '-c', source], { stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });

async function scenario(name, fn) {
  const caseDir = path.join(runDir, name);
  fs.mkdirSync(caseDir);
  try {
    const result = await fn(caseDir);
    save(path.join(name, 'result.json'), { name, status: 'pass', ...result });
    console.log(JSON.stringify({ name, status: 'pass', ...result }));
  } catch (error) {
    save(path.join(name, 'result.json'), { name, status: 'fail', error: String(error) });
    console.log(JSON.stringify({ name, status: 'fail', error: String(error).slice(0, 300) }));
    process.exitCode = 1;
  }
}

async function main() {
  const port = await new Promise(resolve => { let text = ''; server.stdout.on('data', c => { text += c.toString(); if (text.includes('\n')) resolve(Number(text.trim())); }); });
  const url = `http://127.0.0.1:${port}/causality-smoke.html`;

  // 1. Overflow: tiny producer buffers force real drop-newest accounting.
  await scenario('overflow-drop-newest', async dir => {
    const { child, trace, client } = await launch(dir, ['--xtrace-test-buffer-capacity=5']);
    await openPage(client, url);
    await new Promise(r => setTimeout(r, 3000));
    await client.send('XTrace.stopCapture');
    await new Promise(r => setTimeout(r, 12000));
    const manifest = manifestFor(trace);
    assert.equal(manifest.terminal.state, 'incomplete');
    assert.match(manifest.terminal.reason, /dropped>0/, `reason=${manifest.terminal.reason}`);
    const totalDropped = manifest.producers.reduce((a, p) => a + Number(p.dropped), 0);
    assert(totalDropped > 0, 'no dropped events recorded');
    assertEquations(manifest);
    // drop-newest: written prefix contiguous per producer (tail-only gaps).
    const lines = fs.readFileSync(trace, 'utf8').trim().split('\n').map(l => JSON.parse(l));
    for (const p of manifest.producers) {
      const seqs = lines.filter(l => l.producer_id === p.producer_id).map(l => Number(l.producer_seq)).sort((a, b) => a - b);
      for (let i = 1; i < seqs.length; i++) assert.equal(seqs[i], seqs[i - 1] + 1, `middle gap for ${p.producer_id}`);
    }
    await client.send('Browser.close');
    await new Promise(r => child.once('exit', r));
    return { totalDropped, events: lines.length, producers: manifest.producers.length };
  });

  // 2. Renderer crash mid-capture: crashed producers stay unconfirmed; the
  //    stop deadline reports them instead of fabricating a terminal.
  await scenario('renderer-crash-unconfirmed', async dir => {
    const { child, trace, client } = await launch(dir, []);
    const { targetId, sessionId } = await openPage(client, url);
    await new Promise(r => setTimeout(r, 4000));
    // The crash reply races with renderer death; a timeout here is
    // expected and not a failure.
    await client.send('Page.crash', {}, sessionId).catch(() => {});
    await new Promise(r => setTimeout(r, 5000));
    await client.send('XTrace.stopCapture');
    await new Promise(r => setTimeout(r, 12000));    // stop-after + 2s deadline
    const manifest = manifestFor(trace);
    assert.equal(manifest.terminal.state, 'incomplete');
    assert.match(manifest.terminal.reason, /stop-timeout|producer-unconfirmed|renderer/);
    assert(manifest.terminal.unconfirmed_producers.length > 0, 'expected unconfirmed producers');
    assertEquations(manifest);
    const lines = fs.readFileSync(trace, 'utf8').trim().split('\n').map(l => JSON.parse(l));
    assert(lines.length > 0, 'no partial data preserved');
    await client.send('Browser.close');
    await new Promise(r => child.once('exit', r));
    return { events: lines.length, unconfirmed: manifest.terminal.unconfirmed_producers.length };
  });

  // 3. Disk write failure: trace path inside a read-only directory.
  await scenario('disk-write-failure', async dir => {
    const readOnly = path.join(dir, 'writable');
    fs.mkdirSync(readOnly);
    fs.writeFileSync(path.join(readOnly, 'trace.ndjson'), '');
    fs.chmodSync(path.join(readOnly, 'trace.ndjson'), 0o444);
    const { child, trace, client } = await launch(dir, []);
    // Override trace path after launch setup: relaunch with the read-only path.
    child.kill('SIGKILL');
    await new Promise(r => child.once('exit', r));
    const args2 = ['--headless=new', '--remote-debugging-pipe', '--no-first-run',
      '--xtrace-enable', `--xtrace-file=${readOnly}/trace.ndjson`,
      '--xtrace-categories=reverse',
      `--user-data-dir=${path.join(dir, 'profile2')}`, 'about:blank'];
    const env = process.env;
    const stderr = fs.openSync(path.join(dir, 'stderr2.log'), 'w');
    const child2 = spawn(executable, args2, { env, stdio: ['ignore', 'ignore', stderr, 'pipe', 'pipe'] });
    fs.closeSync(stderr);
    const client2 = new PipeClient(child2);
    await openPage(client2, url);
    await new Promise(r => setTimeout(r, 4000));
    await client2.send('XTrace.stopCapture');
    await new Promise(r => setTimeout(r, 7000));
    const manifest = manifestFor(`${readOnly}/trace.ndjson`);
    assert.notEqual(manifest.terminal.state, 'complete', 'disk failure must not report complete');
    assert.match(manifest.terminal.reason, /disk-write-failure|write-failures/);
    assertEquations(manifest);
    await client2.send('Browser.close');
    await new Promise(r => child2.once('exit', r));
    fs.chmodSync(readOnly, 0o755);
    return { reason: manifest.terminal.reason, producers: manifest.producers.length };
  });

  // 4. Browser shutdown mid-capture (no stop request): DP5 evidence — the
  //    teardown settles only what reached the writer and reports
  //    browser-shutdown, never complete.
  await scenario('browser-shutdown-midcapture', async dir => {
    const { child, trace, client } = await launch(dir, []);  // no stop-after
    await openPage(client, url);
    await new Promise(r => setTimeout(r, 6000));
    await client.send('Browser.close');  // graceful shutdown mid-capture
    await new Promise(r => child.once('exit', r));
    const manifest = manifestFor(trace);
    assert.notEqual(manifest.terminal.state, 'complete');
    assert.equal(manifest.terminal.reason, 'browser-shutdown');
    assert(manifest.producers.length > 0, 'no producers registered before shutdown');
    const lines = fs.readFileSync(trace, 'utf8').trim().split('\n');
    assert(lines.length > 0, 'queued data was not drained by BLOCK_SHUTDOWN writer');
    return { events: lines.length, reason: manifest.terminal.reason };
  });

  server.kill('SIGTERM');
  console.log(`Evidence: ${runDir}`);
}

main().catch(e => { console.error(e); server.kill('SIGTERM'); process.exit(1); });
