// Architect R1 re-review probe 5: paginate the REAL accepted-p55 capture
// with the bindings predicate. Bindings rows come from TWO producers
// (590 + 2) whose producer_seq spaces are independent — the numeric
// cursor is producer-blind, so page sums may not equal the file truth.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const root = path.resolve(__dirname, '..', '..', '..');
const { createWorkspace } = require(path.join(root, 'xtrace-host/src/workspace'));
const { createEvidenceIndex } = require(path.join(root, 'xtrace-host/src/evidence-index'));

const SRC = path.join(root,
    'chromium/src/out/XTraceIntegration/validation/p55-e7-ERduFv');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'arch-cursor-real-'));
const ws = createWorkspace(tmp);
fs.mkdirSync(path.join(tmp, 'traces'), { recursive: true });
fs.cpSync(SRC, path.join(tmp, 'traces', 'real'), { recursive: true });

const index = createEvidenceIndex(path.join(ws.dir('index'), 'index.db'));
const rebuilt = index.rebuildFromDir(path.join(tmp, 'traces'));
const captureId = rebuilt[0].captureId;

// file truth
let bindTruth = 0, ignTruth = 0;
const perProducer = {};
for (const line of fs.readFileSync(path.join(SRC, 'trace.ndjson'), 'utf8').split('\n')) {
  if (!line.trim()) continue;
  let e; try { e = JSON.parse(line); } catch { continue; }
  const isBind = e.channel === 'bindings' || /WebIDL\.entry/.test(String(e.api || ''));
  if (isBind) { bindTruth++; perProducer[e.producer_id] = (perProducer[e.producer_id] || 0) + 1; }
  if (e.ignition) ignTruth++;
}

function paginate(predicates, maxRows) {
  let cursor = null, sum = 0, pages = 0;
  const seen = new Set();
  for (;;) {
    const scan = index.scanEvents(captureId, { fromSeq: cursor, maxRows,
        maxBytes: 1 << 26, predicates });
    sum += scan.rows.length;
    for (const r of scan.rows) seen.add(`${r.producer_id}#${r.producer_seq}`);
    pages++;
    if (scan.window_complete) break;
    cursor = scan.next_cursor;
    if (pages > 5000) return { sum, pages, unique: seen.size, aborted: true };
  }
  return { sum, pages, unique: seen.size };
}

const out = {
  bindings_truth: bindTruth, bindings_by_producer: perProducer,
  ignition_truth: ignTruth,
  bindings_paged_100: paginate({ bindings: true }, 100),
  bindings_paged_7: paginate({ bindings: true }, 7),
  bindings_single_page: index.scanEvents(captureId,
      { maxRows: 1 << 20, maxBytes: 1 << 26,
        predicates: { bindings: true } }).rows.length,
  ignition_paged_500: paginate({ ignition: true }, 500),
};
out.bindings_page_sum_equals_truth = out.bindings_paged_100.unique === bindTruth;
out.bindings_lost = bindTruth - out.bindings_paged_100.unique;
console.log(JSON.stringify(out, null, 1));
index.close();
