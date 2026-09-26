// Architect R1 re-review probe 4: does the D2 cursor contract hold for
// MULTI-PRODUCER captures? producer_seq is per-producer, so a numeric
// cursor taken from one producer can skip another producer's rows.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const root = path.resolve(__dirname, '..', '..', '..');
const { createWorkspace } = require(path.join(root, 'xtrace-host/src/workspace'));
const { createEvidenceIndex } = require(path.join(root, 'xtrace-host/src/evidence-index'));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'arch-cursor-'));
const ws = createWorkspace(tmp);
const dir = path.join(tmp, 'traces', 'cap-multi');
fs.mkdirSync(dir, { recursive: true });

const lines = [];
let rtxSeq = 0, bnetSeq = 0;
const ev = (producer, seq, extra) => JSON.stringify({
  schema_version: 3, producer_id: producer, process_epoch: '1',
  producer_seq: String(seq), writer_seq: '1', config_generation: '1',
  mono_time_us: String(seq), wall_time_us: String(seq), pid: 1, tid: 1,
  category: 'reverse', phase: 'call', api: 'X.event', args: [], stack: [],
  attribution: { status: 'unresolved' },
  causality: { kind: 'singleton', call_id: `s:${seq}`, parent_id: null,
               depth: 0, duration_us: null },
  ...extra,
});
// interleave: 8 renderer rows then 1 browser (bindings) row, repeatedly
for (let block = 0; block < 40; block++) {
  for (let i = 0; i < 8; i++) {
    rtxSeq += 1;
    lines.push(ev('rtx:1:1', rtxSeq, { api: `Pad.e${i}` }));
  }
  bnetSeq += 1;
  lines.push(ev('bnet:9:1', bnetSeq, { api: 'WebIDL.entry', channel: 'bindings' }));
}
fs.writeFileSync(path.join(dir, 'trace.ndjson'), lines.join('\n') + '\n');
fs.writeFileSync(path.join(dir, 'trace.manifest.json'), JSON.stringify({
  schema_version: 3, capture_id: 'cap-multi', accounting_model: '2',
  observation_coverage: 'partial', terminal: { state: 'complete' },
  counts: { eligible: String(lines.length) }, producers: [] }));

const index = createEvidenceIndex(path.join(ws.dir('index'), 'index.db'));
const rebuilt = index.rebuildFromDir(path.join(tmp, 'traces'));
const captureId = rebuilt[0].captureId;
const truth = lines.filter(l => JSON.parse(l).channel === 'bindings').length;

const out = { total_events: rebuilt[0].eventCount, bindings_truth: truth };

// paginate the bindings predicate with a small page size
let cursor = null, sum = 0, pages = 0, seen = [];
for (;;) {
  const scan = index.scanEvents(captureId, { fromSeq: cursor, maxRows: 5,
      maxBytes: 1 << 20, predicates: { bindings: true } });
  sum += scan.rows.length;
  seen.push(...scan.rows.map(r => `${r.producer_id}#${r.producer_seq}`));
  pages += 1;
  if (scan.window_complete) { break; }
  cursor = scan.next_cursor;
  if (pages > 60) { out.aborted = 'pagination did not terminate'; break; }
}
out.paginated = { pages, matched_sum: sum, unique: new Set(seen).size };
out.page_sum_equals_truth = sum === truth;
out.missing = truth - new Set(seen).size;

// single-page control (what the shipped gate does)
const one = index.scanEvents(captureId, { maxRows: 1 << 20,
    maxBytes: 1 << 26, predicates: { bindings: true } });
out.single_page_rows = one.rows.length;
out.single_page_equals_truth = one.rows.length === truth;

console.log(JSON.stringify(out, null, 1));
index.close();
