'use strict';
// P6-E2 gates: the derived index REBUILDS from capture directories
// (rebuild IS the acceptance case); query rows carry capture+producer+
// seq references; the 13 A-group tools execute through the Broker.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createWorkspace } = require('../src/workspace');
const { createBroker, TIERS } = require('../src/broker');
const { createEvidenceIndex } = require('../src/evidence-index');
const { createAGroupAdapters } = require('../src/adapters-agroup');

function fixtureCapture(root, name) {
  const dir = path.join(root, 'traces', name);
  fs.mkdirSync(dir, { recursive: true });
  const trace = path.join(dir, 'trace.ndjson');
  const events = [
    {schema_version: 3, producer_id: 'rtx:a:1:1', process_epoch: '1',
     producer_seq: '1', writer_seq: '1', config_generation: '1',
     mono_time_us: '1', wall_time_us: '1', pid: 1, tid: 1,
     category: 'reverse', phase: 'call', api: 'Document.cookie.set',
     args: [{name: 'sess', value: 'zzz'}], stack: [],
     attribution: {status: 'unresolved'},
     causality: {kind: 'paired', call_id: 's:1', parent_id: null,
                 depth: 0, duration_us: null}},
    {schema_version: 3, producer_id: 'rtx:a:1:1', process_epoch: '1',
     producer_seq: '2', writer_seq: '1', config_generation: '1',
     mono_time_us: '2', wall_time_us: '2', pid: 1, tid: 1,
     category: 'reverse', phase: 'return', api: 'Document.cookie.set',
     args: [], stack: [], attribution: {status: 'unresolved'},
     causality: {kind: 'paired', call_id: 's:1', parent_id: null,
                 depth: 0, duration_us: '5'}},
    {schema_version: 3, producer_id: 'rtx:a:1:1', process_epoch: '1',
     producer_seq: '3', writer_seq: '1', config_generation: '1',
     mono_time_us: '3', wall_time_us: '3', pid: 1, tid: 1,
     category: 'reverse', phase: 'call', api: 'ValueTap.observe',
     args: [], stack: [], attribution: {status: 'unresolved'},
     causality: {kind: 'singleton', call_id: 's:2', parent_id: null,
                 depth: 0, duration_us: null},
     value_tap: {channel: 'impl', value_role: 'unclassified',
                 slot: 'accumulator', timepoint: 'pre-dispatch',
                 instance: '9/5', offset: '22', window_id: '0',
                 object_token: '7', plan_serial: '1',
                 value: {t: 'i', state: 'captured', v: 3}} },
    {schema_version: 3, producer_id: 'rtx:a:1:1', process_epoch: '1',
     producer_seq: '4', writer_seq: '1', config_generation: '1',
     mono_time_us: '4', wall_time_us: '4', pid: 1, tid: 1,
     category: 'reverse', phase: 'call', api: 'Ignition.execute',
     args: [], stack: [], attribution: {status: 'unresolved'},
     causality: {kind: 'singleton', call_id: 's:3', parent_id: null,
                 depth: 0, duration_us: null},
     ignition: {script_id: '9', bytecode_version: '5',
                bytecode_offset: '0', opcode: 'GetNamedProperty',
                tier: 'ignition', activation_ref: null}},
  ];
  fs.writeFileSync(trace, events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  fs.writeFileSync(path.join(dir, 'trace.manifest.json'), JSON.stringify({
    manifest_version: 1, schema_version: 3, capture_id: name,
    accounting_model: '2', observation_coverage: 'partial',
    terminal: {state: 'complete', reason: null},
    counts: {eligible: '10', enqueued: '10', dropped: '0', accepted: '10',
             written: '10', failed: '0', sampled_out: '2',
             partial_observations: '1'},
    producers: [
      {producer_id: 'rtx:a:1:1', process_epoch: '1', kind: 'renderer',
       eligible: '10', enqueued: '10', dropped: '0', sampled_out: '2',
       partial_observations: '1', accepted: '10', written: '10',
       failed: '0', watermark: {received: true}},
      {producer_id: 'bnet:b:2:1', process_epoch: '2', kind: 'browser',
       eligible: '0', enqueued: '0', dropped: '0', sampled_out: '0',
       accepted: '0', written: '0', failed: '0',
       watermark: {received: false}},
    ],
  }));
  // asset manifest + one content file
  const assetDir = path.join(dir, 'assets', 'trace');
  fs.mkdirSync(assetDir, { recursive: true });
  const script = 'var k = "sess"; function probe(x){ return x + 0x428a2f98; }';
  const crypto = require('node:crypto');
  const digest = crypto.createHash('sha1').update(script).digest('hex');
  fs.writeFileSync(path.join(assetDir, `sha1_${digest}.js`), script);
  fs.writeFileSync(path.join(assetDir, 'manifest.ndjson'), JSON.stringify({
    kind: 'inline-script', asset_id: `sha1:${digest}`,
    url: 'http://127.0.0.1:1/page.html',
    content_path: `assets/trace/sha1_${digest}.js`,
  }) + '\n');
  return { dir, trace, digest };
}

test('index rebuilds from capture dirs and queries carry references', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xtrace-e2-'));
  const ws = createWorkspace(root);
  const { dir, digest } = fixtureCapture(root, 'cap-e2');

  const dbPath = path.join(ws.dir('index'), 'index.db');
  const index = createEvidenceIndex(dbPath);
  // REBUILD (the acceptance case): from the traces root only.
  const ingested = index.rebuildFromDir(path.join(root, 'traces'));
  assert.equal(ingested.length, 1);
  assert.equal(ingested[0].eventCount, 4);

  const captures = index.listCaptures();
  assert.equal(captures.length, 1);
  assert.equal(captures[0].capture_id, 'cap-e2');
  assert.equal(captures[0].terminal, 'complete');
  assert.equal(captures[0].coverage, 'partial');
  assert.equal(captures[0].total_sampled_out, 2);

  const apis = index.topApis('cap-e2');
  assert.ok(apis.find((r) => r.api === 'Document.cookie.set' && r.count === 2));
  assert.ok(apis.find((r) => r.api === 'Ignition.execute'));

  const assets = index.assetRows('cap-e2');
  assert.equal(assets.length, 1);
  assert.equal(assets[0].asset_id, `sha1:${digest}`);

  // event-level: streamed with capture+producer+seq references
  const events = index.streamEvents('cap-e2', { api: 'Document.cookie.set' });
  assert.equal(events.length, 2);
  for (const e of events) {
    assert.equal(e.capture_id, 'cap-e2');
    assert.equal(e.producer_id, 'rtx:a:1:1');
    assert.ok(e.producer_seq);
  }

  // rebuild AGAIN after a wipe: same content (derived, not a second truth)
  index.rebuildFromDir(path.join(root, 'traces'));
  assert.equal(index.listCaptures().length, 1);
  assert.equal(index.topApis('cap-e2').length, apis.length);
  index.close();
});

test('A-group adapters execute through the Broker with references', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xtrace-e2b-'));
  const ws = createWorkspace(root);
  fixtureCapture(root, 'cap-adapt');
  const index = createEvidenceIndex(path.join(ws.dir('index'), 'index.db'));
  index.rebuildFromDir(path.join(root, 'traces'));
  const broker = createBroker({ workspace: ws });
  const adapters = createAGroupAdapters({ workspace: ws, index });

  const byName = {};
  for (const adapter of adapters) {
    byName[broker.register(adapter).name] = adapter;
  }
  // the FROZEN inventory A-group 13 are all registered (the Host may
  // carry additional internal query primitives beyond the agent list)
  const INVENTORY_A13 = [
    'code_search', 'scripts_list', 'jsvmp_query', 'webapi_query',
    'find_param_entry', 'crypto_scan', 'jsvmp_split_dispatcher',
    'jsvmp_disassemble', 'skill_list', 'skill_get', 'skill_read_resource',
    'notes_get', 'recall',
  ];
  for (const name of INVENTORY_A13) {
    assert.ok(byName[name], `inventory tool missing: ${name}`);
  }
  assert.ok(Object.keys(byName).length >= 13);

  // trace_query through the broker (single entry)
  const rows = await broker.execute(byName.trace_query,
      { capture_id: 'cap-adapt', api: 'Ignition.execute' }, { origin: 'agent' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].producer_id, 'rtx:a:1:1');
  assert.ok(rows[0].producer_seq);

  // jsvmp_query (degraded, disclosed) returns ignition rows
  const jsvmp = await broker.execute(byName.jsvmp_query,
      { capture_id: 'cap-adapt' }, { origin: 'mcp' });
  assert.equal(jsvmp.length, 1);
  assert.equal(jsvmp[0].ignition.opcode, 'GetNamedProperty');

  // code_search finds the param inside the indexed asset
  const hits = await broker.execute(byName.code_search,
      { capture_id: 'cap-adapt', pattern: '0x428a2f98' }, { origin: 'ui' });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].capture_id, 'cap-adapt');

  // crypto_scan: SHA-256 constant signature
  const cryptoHits = await broker.execute(byName.crypto_scan,
      { capture_id: 'cap-adapt' }, { origin: 'agent' });
  assert.ok(cryptoHits.some((h) => h.signature === 'SHA256_K_HEAD'));

  // find_param_entry crosses events and assets
  const found = await broker.execute(byName.find_param_entry,
      { capture_id: 'cap-adapt', param: 'sess' }, { origin: 'agent' });
  assert.ok(found.some((f) => f.kind === 'event'));
  assert.ok(found.some((f) => f.kind === 'asset'));

  // unavailable adapters refuse with the migration reason
  await assert.rejects(() => broker.execute(byName.jsvmp_disassemble,
      { bytecode: 'x' }, { origin: 'agent' }), /not migrated/);

  index.close();
});
