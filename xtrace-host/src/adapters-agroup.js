'use strict';
// P6-R1 A-group adapters — the inventory 13 plus Host-internal query
// primitives. R1 hardening:
//   * EVERY event-level tool is a streaming scan with the predicate
//     PUSHED INTO the scan and the D2 window contract (scanned_events/
//     matched/total_events/window_complete/next_cursor) — no take-then-
//     -filter anywhere (B3).
//   * Byte ceilings on returns + truncated disclosure (M13).
//   * skill/notes reads go through workspace.assertInside (B6) — the
//     realpath gate, never a string prefix.
//   * The four fingerprint-layer env tools register as unavailable
//     WITH the P7 reason (M5: disclosed, not silently absent).
//   * evidence_jump ships as a first-class read tool (M6).

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { TIERS } = require('./broker');

// Per-return byte ceiling (D2): single tool returns stay bounded; more
// goes through the cursor.
const MAX_RETURN_BYTES = 262144;

function createAGroupAdapters({ workspace, index, host }) {
  const a = [];
  void host; // B-group tools hold the live host; A-group is host-free

  const windowEnvelope = (scan) => ({
    rows: scan.rows.length, scanned_events: scan.scanned_events,
    matched: scan.matched, total_events: scan.total_events,
    window_complete: scan.window_complete,
    next_cursor: scan.next_cursor, bytes: scan.bytes,
  });

  const clampInt = (v, lo, hi, dflt) => {
    const n = Number(v);
    if (!Number.isFinite(n)) {
      return dflt;
    }
    return Math.max(lo, Math.min(hi, Math.round(n)));
  };
  const requireString = (args, field) => {
    const v = args && args[field];
    if (typeof v !== 'string' || !v) {
      throw new Error(`missing required string argument: ${field}`);
    }
    return v;
  };
  const captureRow = (captureId) => {
    const rows = index.listCaptures()
        .filter((c) => c.capture_id === captureId);
    if (!rows.length) {
      throw new Error(`unknown capture: ${captureId}`);
    }
    return rows[0];
  };
  const captureDir = (captureId) => captureRow(captureId).dir;

  // ---- event-level queries (D2 contract everywhere) --------------------
  a.push({
    name: 'trace_query', tier: TIERS.READ_EVIDENCE,
    input: { capture_id: 'string', api: 'string?', from_line: 'int?',
             limit: 'int?' },
    output: 'rows + window contract (scanned/matched/total/complete/cursor)',
    scope: 'workspace traces',
    run: async (args) => {
      const captureId = requireString(args, 'capture_id');
      const scan = index.scanEvents(captureId, {
        fromLine: args.from_line ?? null,
        maxRows: clampInt(args.limit, 1, 1000, 100),
        maxBytes: MAX_RETURN_BYTES,
        predicates: args.api ? { api: args.api } : {},
      });
      return { ...windowEnvelope(scan), events: scan.rows };
    },
  });

  a.push({
    name: 'trace_summary', tier: TIERS.READ_EVIDENCE,
    input: { capture_id: 'string?' },
    output: 'capture rows (terminal, coverage, counters)',
    run: async (args) => args && args.capture_id
        ? [captureRow(args.capture_id)]
        : index.listCaptures(),
  });

  a.push({
    name: 'api_top', tier: TIERS.READ_EVIDENCE,
    input: { capture_id: 'string', limit: 'int?' },
    output: 'api aggregate rows',
    run: async (args) => index.topApis(
        requireString(args, 'capture_id'), clampInt(args.limit, 1, 200, 20)),
  });

  // ---- asset reads ------------------------------------------------------
  a.push({
    name: 'assets_list', tier: TIERS.READ_EVIDENCE,
    input: { capture_id: 'string', kind: 'string?' },
    output: 'asset rows',
    run: async (args) => index.assetRows(
        requireString(args, 'capture_id'), args.kind || undefined),
  });

  a.push({
    name: 'asset_read', tier: TIERS.READ_EVIDENCE,
    input: { capture_id: 'string', asset_id: 'string', max_bytes: 'int?' },
    output: 'asset content (bounded, truncated disclosed)',
    run: async (args) => {
      const rows = index.assetRows(requireString(args, 'capture_id'))
          .filter((r) => r.asset_id === requireString(args, 'asset_id'));
      if (!rows.length || !rows[0].content_path) {
        throw new Error(`asset not indexed: ${args.asset_id}`);
      }
      const dir = captureDir(args.capture_id);
      const content = path.resolve(dir, rows[0].content_path);
      workspace.assertInside(content, 'asset content');
      const max = clampInt(args.max_bytes, 1, MAX_RETURN_BYTES, 65536);
      const buf = fs.readFileSync(content);
      return {
        asset_id: rows[0].asset_id, kind: rows[0].kind, url: rows[0].url,
        bytes: Math.min(buf.length, max), truncated: buf.length > max,
        total_bytes: buf.length,
        content: buf.subarray(0, max).toString('utf8'),
      };
    },
  });

  // Stream an asset line by line with an early-stopping matcher.
  async function scanAssetLines(content, onLine) {
    const rl = readline.createInterface({
      input: fs.createReadStream(content, { encoding: 'utf8' }),
      crlfDelay: Infinity,
    });
    let lineNo = 0;
    let stopped = false;
    const stop = () => { stopped = true; };
    for await (const line of rl) {
      lineNo += 1;
      await onLine(line, lineNo, stop);
      if (stopped) {
        break;
      }
    }
    rl.close();
  }

  a.push({
    name: 'code_search', tier: TIERS.READ_EVIDENCE,
    input: { capture_id: 'string', pattern: 'string', limit: 'int?' },
    output: 'matching asset rows with line hits',
    run: async (args) => {
      const captureId = requireString(args, 'capture_id');
      const pattern = requireString(args, 'pattern');
      let re;
      try {
        re = new RegExp(pattern);
      } catch {
        re = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
      }
      const limit = clampInt(args.limit, 1, 100, 20);
      const dir = captureDir(captureId);
      const hits = [];
      for (const row of index.assetRows(captureId)) {
        if (!row.content_path || hits.length >= limit) {
          continue;
        }
        const content = path.resolve(dir, row.content_path);
        if (!workspace.contains(content)) {
          continue;
        }
        await scanAssetLines(content, (line, lineNo, stop) => {
          if (re.test(line)) {
            hits.push({ capture_id: captureId, asset_id: row.asset_id,
                        kind: row.kind, line: lineNo,
                        text: line.slice(0, 200) });
            if (hits.length >= limit) {
              stop();
            }
          }
        });
      }
      return hits;
    },
  });

  // ---- script surface ---------------------------------------------------
  a.push({
    name: 'scripts_list', tier: TIERS.READ_EVIDENCE,
    input: { capture_id: 'string' },
    output: 'script asset rows',
    run: async (args) => index.assetRows(
        requireString(args, 'capture_id'))
        .filter((r) => /script/.test(String(r.kind || ''))),
  });

  // ---- event-surface queries (streamed, D2 contract) --------------------
  a.push({
    name: 'jsvmp_query', tier: TIERS.READ_EVIDENCE,
    degradedReason: 'first-batch event surface only: Ignition pre-events ' +
                    '(script/offset/opcode); vpc/locals/env fields await ' +
                    'later observer versions',
    input: { capture_id: 'string', script_id: 'string?', from_line: 'int?',
             limit: 'int?' },
    output: 'ignition rows + window contract',
    run: async (args) => {
      const captureId = requireString(args, 'capture_id');
      const scan = index.scanEvents(captureId, {
        fromLine: args.from_line ?? null,
        maxRows: clampInt(args.limit, 1, 1000, 100),
        maxBytes: MAX_RETURN_BYTES,
        predicates: { ignition: true },
      });
      const filtered = !args.script_id ? scan.rows : scan.rows.filter((r) =>
          r.event.ignition.script_id === String(args.script_id));
      return { ...windowEnvelope(scan), events: filtered.map((r) => ({
        capture_id: r.capture_id, producer_id: r.producer_id,
        producer_seq: r.producer_seq, ignition: r.event.ignition,
      })) };
    },
  });

  a.push({
    name: 'webapi_query', tier: TIERS.READ_EVIDENCE,
    degradedReason: 'first-batch WebIDL interface set only (P5 frozen ' +
                    'scope); URL/Body/Element/Performance families beyond ' +
                    'the set are not captured',
    input: { capture_id: 'string', api: 'string?', from_line: 'int?',
             limit: 'int?' },
    output: 'WebIDL rows + window contract',
    run: async (args) => {
      const captureId = requireString(args, 'capture_id');
      const scan = index.scanEvents(captureId, {
        fromLine: args.from_line ?? null,
        maxRows: clampInt(args.limit, 1, 1000, 100),
        maxBytes: MAX_RETURN_BYTES,
        predicates: { bindings: true },
      });
      const filtered = !args.api ? scan.rows
          : scan.rows.filter((r) => r.event.api === args.api);
      return { ...windowEnvelope(scan), events: filtered.map((r) => ({
        capture_id: r.capture_id, producer_id: r.producer_id,
        producer_seq: r.producer_seq, api: r.event.api,
        webidl_entry: r.event.webidl_entry || null,
        webidl_outcome: r.event.webidl_outcome || null,
      })) };
    },
  });

  a.push({
    name: 'find_param_entry', tier: TIERS.READ_EVIDENCE,
    input: { capture_id: 'string', param: 'string', limit: 'int?' },
    output: 'events + asset lines naming the parameter (window contract)',
    run: async (args) => {
      const captureId = requireString(args, 'capture_id');
      const param = requireString(args, 'param');
      const scan = index.scanEvents(captureId, {
        maxRows: clampInt(args.limit, 1, 100, 20),
        maxBytes: MAX_RETURN_BYTES,
        predicates: { param },
      });
      const code = [];
      const dir = captureDir(captureId);
      for (const row of index.assetRows(captureId)) {
        if (!row.content_path || code.length >= 20) {
          continue;
        }
        const content = path.resolve(dir, row.content_path);
        if (!workspace.contains(content)) {
          continue;
        }
        await scanAssetLines(content, (line, lineNo, stop) => {
          if (line.includes(param)) {
            code.push({ capture_id: captureId, asset_id: row.asset_id,
                        line: lineNo, kind: 'asset' });
            if (code.length >= 20) {
              stop();
            }
          }
        });
      }
      return { ...windowEnvelope(scan),
               events: scan.rows.map((r) => ({
                 capture_id: r.capture_id, producer_id: r.producer_id,
                 producer_seq: r.producer_seq, api: r.api, kind: 'event',
               })),
               asset_lines: code };
    },
  });

  a.push({
    name: 'crypto_scan', tier: TIERS.READ_EVIDENCE,
    input: { capture_id: 'string' },
    output: 'public crypto constants/structure hits in script assets',
    run: async (args) => {
      const signatures = [
        { name: 'AES_SBOX_HEAD', re: /0x63,\s*0x7c,\s*0x77,\s*0x7b/ },
        { name: 'SHA256_K_HEAD', re: /0x428a2f98/ },
        { name: 'MD5_T_HEAD', re: /0xd76aa478/ },
        { name: 'BASE64_STD', re: /[A-Za-z0-9+/]{40,}={0,2}/ },
        { name: 'RC4_LIKE', re: /\(\s*\w+\s*%\s*256\s*\)/ },
      ];
      const captureId = requireString(args, 'capture_id');
      const dir = captureDir(captureId);
      const hits = [];
      for (const row of index.assetRows(captureId)) {
        if (!row.content_path) {
          continue;
        }
        const content = path.resolve(dir, row.content_path);
        if (!workspace.contains(content)) {
          continue;
        }
        const text = fs.readFileSync(content, 'utf8');
        for (const sig of signatures) {
          if (sig.re.test(text)) {
            hits.push({ capture_id: captureId, asset_id: row.asset_id,
                        kind: row.kind, signature: sig.name });
          }
        }
      }
      return hits;
    },
  });

  // ---- evidence jump (M6: first-class tool over the index) -------------
  a.push({
    name: 'evidence_jump', tier: TIERS.READ_EVIDENCE,
    input: { ref: 'string' },
    output: 'capture|producer|seq -> trace line + byte offset + event',
    run: async (args) => {
      const ref = requireString(args, 'ref');
      const parts = ref.split('|');
      if (parts.length < 3) {
        throw new Error(`bad evidence reference: ${ref}`);
      }
      const [captureId, producerId, seq] = parts;
      const capture = captureRow(captureId);
      // The index row names the trace file for THIS capture (B5: never
      // a hardcoded filename).
      const traceFile = capture.trace_file ||
          path.join(capture.dir, 'trace.ndjson');
      // STREAMING locate: chunked scan, early stop at the match.
      const fd = fs.openSync(traceFile, 'r');
      try {
        const chunkSize = 1 << 16;
        const buffer = Buffer.allocUnsafe(chunkSize);
        let carry = '';
        let lineNo = 0;
        let baseBytes = 0;   // bytes consumed from completed chunks
        while (true) {
          const bytesRead = fs.readSync(fd, buffer, 0, chunkSize, null);
          if (bytesRead <= 0) {
            break;
          }
          const chunk = carry + buffer.toString('utf8', 0, bytesRead);
          let start = 0;
          let nl;
          while ((nl = chunk.indexOf('\n', start)) !== -1) {
            const line = chunk.slice(start, nl);
            lineNo += 1;
            if (line.includes(`"producer_id":"${producerId}"`) &&
                line.includes(`"producer_seq":"${seq}"`)) {
              return { capture_id: captureId, producer_id: producerId,
                       producer_seq: seq, line: lineNo,
                       byte_offset: baseBytes + Buffer.byteLength(
                           chunk.slice(0, start), 'utf8'),
                       trace_file: traceFile,
                       event: safeParse(line) };
            }
            start = nl + 1;
          }
          baseBytes += Buffer.byteLength(
              chunk.slice(0, chunk.length - carry.length), 'utf8');
          carry = chunk.slice(start);
        }
      } finally {
        fs.closeSync(fd);
      }
      throw new Error(`reference not found in capture: ${ref}`);
    },
  });

  // ---- notes ------------------------------------------------------------
  a.push({
    name: 'notes_get', tier: TIERS.READ_EVIDENCE,
    input: { site: 'string?' },
    output: '.frx-notes.ndjson rows (site filter optional)',
    run: async (args) => {
      const notesPath = path.join(workspace.root, '.frx-notes.ndjson');
      // B6: the realpath gate, not a string prefix
      workspace.assertInside(notesPath, 'notes file');
      if (!fs.existsSync(notesPath)) {
        return [];
      }
      const rows = fs.readFileSync(notesPath, 'utf8').split('\n')
          .filter((l) => l.trim())
          .map((l) => { try { return JSON.parse(l); } catch { return null; } })
          .filter(Boolean);
      return args && args.site ? rows.filter((r) => r.site === args.site)
                               : rows;
    },
  });

  // ---- ledger recall ----------------------------------------------------
  a.push({
    name: 'recall', tier: TIERS.READ_EVIDENCE,
    degradedReason: 'P6 first cut recalls from the Broker audit ledger ' +
                    'JSONL; the frx LedgerBackend query semantics migrate ' +
                    'with their own database in a later pass',
    input: { tool: 'string?', limit: 'int?' },
    output: 'recent audit/ledger rows',
    run: async (args) => {
      const ledgerDir = workspace.dir('ledger');
      const rows = [];
      const files = fs.readdirSync(ledgerDir).filter((f) => f.endsWith('.jsonl'))
          .sort().reverse().slice(0, 8);
      const limit = clampInt(args && args.limit, 1, 200, 50);
      for (const file of files) {
        for (const line of fs.readFileSync(path.join(ledgerDir, file), 'utf8')
            .split('\n').filter((l) => l.trim()).reverse()) {
          try {
            const row = JSON.parse(line);
            if (args && args.tool && row.tool !== args.tool) {
              continue;
            }
            rows.push(row);
            if (rows.length >= limit) {
              return rows;
            }
          } catch {
            continue;
          }
        }
      }
      return rows;
    },
  });

  // ---- frx offline analyzers: NOT yet migrated -------------------------
  a.push({
    name: 'jsvmp_split_dispatcher', tier: TIERS.READ_EVIDENCE,
    unavailableReason: 'babel/AST dispatcher_probe not yet migrated from ' +
                       'frx (MPL-2.0 sources pending transfer)',
    input: { handlers_json: 'string' },
    available: () => false,
    run: async () => { throw new Error('not migrated'); },
  });
  a.push({
    name: 'jsvmp_disassemble', tier: TIERS.READ_EVIDENCE,
    unavailableReason: 'offline disassembler not yet migrated from frx',
    input: { bytecode: 'string' },
    available: () => false,
    run: async () => { throw new Error('not migrated'); },
  });

  // ---- fingerprint-layer env tools: disclosed unavailable (M5) ---------
  for (const name of ['env_current_process',
                      'env_read_current_process_config',
                      'env_write_current_process_config',
                      'env_reset_current_process_default']) {
    a.push({
      name, tier: TIERS.READ_EVIDENCE,
      unavailableReason: 'depends on the fingerprint override layer (P7); ' +
                         'not present in the P6 first batch',
      input: {},
      available: () => false,
      run: async () => { throw new Error('unavailable until P7'); },
    });
  }

  // ---- skills (B6: every path through the realpath gate) ----------------
  const skillsDir = () => {
    const dir = path.join(workspace.root, 'skills');
    workspace.assertInside(dir, 'skills dir');
    return dir;
  };
  a.push({
    name: 'skill_list', tier: TIERS.READ_EVIDENCE,
    input: {},
    output: 'skill directories',
    run: async () => {
      const dir = skillsDir();
      if (!fs.existsSync(dir)) {
        return [];
      }
      return fs.readdirSync(dir, { withFileTypes: true })
          .filter((e) => e.isDirectory())
          .map((e) => ({ name: e.name }));
    },
  });
  for (const [name, what] of [
    ['skill_get', 'SKILL.md'],
    ['skill_read_resource', 'resource'],
  ]) {
    a.push({
      name, tier: TIERS.READ_EVIDENCE,
      input: { name: 'string', resource: 'string?', offset: 'int?',
               limit: 'int?' },
      output: 'skill content (paged, truncated disclosed)',
      run: async (args) => {
        const dir = skillsDir();
        const skillName = requireString(args, 'name');
        if (!/^[A-Za-z0-9._-]+$/.test(skillName)) {
          throw new Error(`invalid skill name: ${skillName}`);
        }
        const skillDir = path.join(dir, skillName);
        // B6: the gate decides — never a string prefix. Symlink and ..
        // escapes die HERE.
        workspace.assertInside(skillDir, 'skill dir');
        let file = path.join(skillDir, 'SKILL.md');
        if (what === 'resource') {
          const resource = requireString(args, 'resource');
          if (resource.startsWith('/') || resource.split('/').includes('..')) {
            throw new Error(`invalid resource name: ${resource}`);
          }
          file = path.join(skillDir, resource);
        }
        workspace.assertInside(file, 'skill file');
        if (!fs.existsSync(file)) {
          throw new Error(`skill resource not found: ${skillName}`);
        }
        const text = fs.readFileSync(file, 'utf8');
        const offset = clampInt(args.offset, 0, text.length, 0);
        const limit = clampInt(args.limit, 1, 1 << 18, 1 << 14);
        return { name: skillName, path: path.relative(dir, file),
                 offset, total: text.length,
                 truncated: offset + limit < text.length,
                 content: text.slice(offset, offset + limit) };
      },
    });
  }

  return a;
}

function safeParse(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

module.exports = { createAGroupAdapters, MAX_RETURN_BYTES };
