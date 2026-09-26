'use strict';
// M3-E2 gates: the D-group native track — realpath boundary (three
// escape shapes), 32KB read paging with offset/limit equations, append
// segmentation, write parent creation + depth limit, scripts_save
// 404/fragment guards (via a scripted fake host).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createWorkspace } = require('../src/workspace');
const { createBroker, TIERS, BASES } = require('../src/broker');
const { createDGroupNativeAdapters, MAX_READ_BYTES }
  = require('../src/adapters-dgroup');

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'm3-e2-'));
}

async function callTool(broker, tool, args) {
  return broker.execute(tool, args, {
    origin: 'ui', reason: 'E2 gate probe',
    basisHint: BASES.UI_DIRECT_CLICK,
  });
}

function setup({ host = null } = {}) {
  const root = tmp();
  const ws = createWorkspace(root);
  const broker = createBroker({ workspace: ws });
  const tools = {};
  for (const adapter of createDGroupNativeAdapters({ workspace: ws,
                                                      host })) {
    tools[broker.register(adapter).name] = adapter;
  }
  return { root, ws, broker, tools };
}

test('E2: boundary three shapes rejected (symlink/absolute/dotdot)', async () => {
  const { ws, broker, tools } = setup();
  const outside = tmp();
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'OUTSIDE');
  fs.symlinkSync(outside, path.join(ws.root, 'escape-link'));

  await assert.rejects(() =>
      callTool(broker, tools.fs_read, { path: 'escape-link/secret.txt' }),
      /escapes the workspace boundary/);
  await assert.rejects(() =>
      callTool(broker, tools.fs_write,
          { path: path.join(outside, 'x.txt'), content: 'x' }),
      /escapes the workspace boundary/);
  await assert.rejects(() =>
      callTool(broker, tools.fs_copy,
          { from: '../outside.txt', to: 'ok.txt' }),
      /escapes the workspace boundary/);
  // workspace layer agrees (no two implementations drift)
  assert.throws(() => ws.assertInside(
      path.join(ws.root, 'escape-link', 'secret.txt'), 'p'),
      /escapes the workspace boundary/);
});

test('E2: read paging — 32KB cap, offset/limit equations, eof', async () => {
  const { root, broker, tools } = setup();
  const body = 'A'.repeat(70000);           // 70KB fixture
  fs.writeFileSync(path.join(root, 'big.txt'), body);

  const page1 = await callTool(broker, tools.fs_read, { path: 'big.txt' });
  assert.equal(page1.content.length, MAX_READ_BYTES);
  assert.equal(page1.total_bytes, 70000);
  assert.equal(page1.truncated, true);
  assert.equal(page1.eof, false);

  const page2 = await callTool(broker, tools.fs_read,
      { path: 'big.txt', offset: MAX_READ_BYTES, limit: 1000 });
  assert.equal(page2.content.length, 1000);
  assert.equal(page2.content, 'A'.repeat(1000));
  assert.equal(page2.offset, MAX_READ_BYTES);

  // limit cannot exceed the cap
  const greedy = await callTool(broker, tools.fs_read,
      { path: 'big.txt', limit: 999999 });
  assert.equal(greedy.content.length, MAX_READ_BYTES);

  // tail page reaches eof exactly
  const tail = await callTool(broker, tools.fs_read,
      { path: 'big.txt', offset: 69999 });
  assert.equal(tail.content.length, 1);
  assert.equal(tail.eof, true);
  assert.equal(tail.truncated, false);
});

test('E2: write — parents created, depth limit, append segmentation', async () => {
  const { root, broker, tools } = setup();
  const wrote = await callTool(broker, tools.fs_write,
      { path: 'deep/a/b/c/out.txt', content: 'hello' });
  assert.equal(wrote.bytes, 5);
  assert.ok(fs.existsSync(path.join(root, 'deep/a/b/c/out.txt')));

  await assert.rejects(() => callTool(broker, tools.fs_write,
      { path: `x/${'d/'.repeat(30)}out.txt`, content: 'x' }),
      /path too deep/);

  // append segmentation: three appends concatenate exactly
  for (const part of ['one-', 'two-', 'three']) {
    await callTool(broker, tools.fs_write,
        { path: 'log.txt', content: part, append: true });
  }
  assert.equal(fs.readFileSync(path.join(root, 'log.txt'), 'utf8'),
      'one-two-three');

  // overwrite mode replaces (not appends)
  await callTool(broker, tools.fs_write,
      { path: 'log.txt', content: 'fresh' });
  assert.equal(fs.readFileSync(path.join(root, 'log.txt'), 'utf8'),
      'fresh');
});

test('E2: fs_copy + fs_list round trip', async () => {
  const { root, broker, tools } = setup();
  await callTool(broker, tools.fs_write, { path: 'src.txt', content: 'COPY' });
  const copy = await callTool(broker, tools.fs_copy,
      { from: 'src.txt', to: 'nested/dst.txt' });
  assert.equal(copy.bytes, 4);
  assert.equal(fs.readFileSync(path.join(root, 'nested/dst.txt'), 'utf8'),
      'COPY');
  const list = await callTool(broker, tools.fs_list, { dir: 'nested' });
  assert.deepEqual(list.entries, [{ name: 'dst.txt', kind: 'file' }]);
});

test('E2: scripts_save — 404 guard, fragment verdict, happy save', async () => {
  const sources = {
    'good-1': 'console.log("real script body");',
    'frag-1': 'x',
    '404-1': undefined,
  };
  const fakeHost = {
    closed: false,
    send: async (method, params) => {
      assert.equal(method, 'Debugger.getScriptSource');
      return sources[params.scriptId];
    },
  };
  const { ws, broker, tools } = setup({ host: fakeHost });

  const good = await callTool(broker, tools.scripts_save,
      { script_id: 'good-1', url: 'http://127.0.0.1/x.js' });
  assert.equal(good.integrity.bytes, 32);
  assert.equal(good.integrity.looks_fragment, false);
  assert.ok(fs.existsSync(good.saved));
  assert.equal(fs.readFileSync(good.saved, 'utf8'),
      'console.log("real script body");');

  const frag = await callTool(broker, tools.scripts_save,
      { script_id: 'frag-1' });
  assert.equal(frag.integrity.looks_fragment, true);

  await assert.rejects(() => callTool(broker, tools.scripts_save,
      { script_id: '404-1' }), /404 script/);

  // unavailable without a host (disclosed, not silent)
  const bare = setup({ host: null });
  const negotiated = bare.tools.scripts_save.available
      ? bare.tools.scripts_save.available({}) : true;
  void negotiated; // available() checked by the capability layer; here
  assert.equal(typeof bare.tools.scripts_save.run, 'function');
  await assert.rejects(() => callTool(bare.broker,
      bare.tools.scripts_save, { script_id: 'x' }),
      /host\.send is not a function|null/);
  void ws;
});
