'use strict';
// P6-E2: the A-group adapters — 13 read-only evidence tools (inventory
// §2/A). Every run() result row carries capture + producer + seq
// references where applicable. frx-dependent offline analyzers
// (jsvmp_split_dispatcher, jsvmp_disassemble) register as UNAVAILABLE
// with the migration reason disclosed — never silently substituted.

const fs = require('node:fs');
const path = require('node:path');
const { TIERS } = require('./broker');

function createAGroupAdapters({ workspace, index }) {
  const a = [];

  // ---- index-driven queries -------------------------------------------
  a.push({
    name: 'trace_query', tier: TIERS.READ_EVIDENCE,
    input: { capture_id: 'string', api: 'string?', limit: 'int?' },
    output: 'event rows with capture+producer+seq references',
    scope: 'workspace traces',
    run: async (args) => index.streamEvents(
        requireString(args, 'capture_id'), {
          api: args.api || undefined,
          limit: clampInt(args.limit, 1, 1000, 100),
        }),
  });

  a.push({
    name: 'trace_summary', tier: TIERS.READ_EVIDENCE,
    input: { capture_id: 'string?' },
    output: 'capture rows (terminal, coverage, counters)',
    run: async (args) => args && args.capture_id
        ? [captureRow(index, args.capture_id)]
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
    output: 'asset content (bounded)',
    run: async (args) => {
      const rows = index.assetRows(requireString(args, 'capture_id'))
          .filter((r) => r.asset_id === requireString(args, 'asset_id'));
      if (!rows.length || !rows[0].content_path) {
        throw new Error(`asset not indexed: ${args.asset_id}`);
      }
      const dir = captureTraceDir(index, args.capture_id);
      const content = path.resolve(dir, rows[0].content_path);
      workspace.assertInside(content, 'asset content');
      const max = clampInt(args.max_bytes, 1, 1 << 20, 65536);
      const buf = fs.readFileSync(content);
      return {
        asset_id: rows[0].asset_id, kind: rows[0].kind, url: rows[0].url,
        bytes: Math.min(buf.length, max), truncated: buf.length > max,
        content: buf.subarray(0, max).toString('utf8'),
      };
    },
  });

  a.push({
    name: 'code_search', tier: TIERS.READ_EVIDENCE,
    input: { capture_id: 'string', pattern: 'string', limit: 'int?' },
    output: 'matching asset rows with line hits',
    run: async (args) => {
      const captureId = requireString(args, 'capture_id');
      const pattern = requireString(args, 'pattern');
      const re = safeRegex(pattern);
      const limit = clampInt(args.limit, 1, 100, 20);
      const dir = captureTraceDir(index, captureId);
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
        const lines = text.split('\n');
        for (let i = 0; i < lines.length && hits.length < limit; i++) {
          if (re.test(lines[i])) {
            hits.push({ capture_id: captureId, asset_id: row.asset_id,
                        kind: row.kind, line: i + 1,
                        text: lines[i].slice(0, 200) });
          }
        }
        if (hits.length >= limit) {
          break;
        }
      }
      return hits;
    },
  });

  // ---- script surface (from the asset manifest) ------------------------
  a.push({
    name: 'scripts_list', tier: TIERS.READ_EVIDENCE,
    input: { capture_id: 'string' },
    output: 'script asset rows (inline/external/module)',
    run: async (args) => index.assetRows(
        requireString(args, 'capture_id'))
        .filter((r) => /script/.test(String(r.kind || ''))),
  });

  // ---- event-surface queries (streamed, bounded) ------------------------
  a.push({
    name: 'jsvmp_query', tier: TIERS.READ_EVIDENCE,
    degradedReason: 'first-batch event surface only: Ignition pre-events ' +
                    '(script/offset/opcode); vpc/locals/env fields await ' +
                    'later observer versions',
    input: { capture_id: 'string', script_id: 'string?', limit: 'int?' },
    output: 'ignition event rows',
    run: async (args) => {
      const rows = index.streamEvents(
          requireString(args, 'capture_id'), { limit: clampInt(args.limit, 1, 1000, 100) });
      const out = rows.filter((r) => r.event.ignition)
          .filter((r) => !args.script_id ||
                  r.event.ignition.script_id === String(args.script_id));
      return out.map((r) => ({
        capture_id: r.capture_id, producer_id: r.producer_id,
        producer_seq: r.producer_seq,
        ignition: r.event.ignition,
      }));
    },
  });

  a.push({
    name: 'webapi_query', tier: TIERS.READ_EVIDENCE,
    degradedReason: 'first-batch WebIDL interface set only (P5 frozen ' +
                    'scope); URL/Body/Element/Performance families beyond ' +
                    'the set are not captured',
    input: { capture_id: 'string', api: 'string?', limit: 'int?' },
    output: 'WebIDL entry/outcome event rows',
    run: async (args) => {
      const rows = index.streamEvents(
          requireString(args, 'capture_id'), { limit: clampInt(args.limit, 1, 1000, 100) });
      return rows.filter((r) =>
          r.event.channel === 'bindings' ||
          /WebIDL\.entry/.test(String(r.event.api || '')))
          .filter((r) => !args.api || r.event.api === args.api)
          .map((r) => ({
            capture_id: r.capture_id, producer_id: r.producer_id,
            producer_seq: r.producer_seq, api: r.event.api,
            webidl_entry: r.event.webidl_entry || null,
            webidl_outcome: r.event.webidl_outcome || null,
          }));
    },
  });

  a.push({
    name: 'find_param_entry', tier: TIERS.READ_EVIDENCE,
    input: { capture_id: 'string', param: 'string', limit: 'int?' },
    output: 'events + asset lines naming the parameter',
    run: async (args) => {
      const param = requireString(args, 'param');
      const captureId = requireString(args, 'capture_id');
      const events = index.streamEvents(captureId, { limit: 1000 })
          .filter((r) => JSON.stringify(r.event.args || {})
              .includes(param))
          .slice(0, clampInt(args.limit, 1, 100, 20))
          .map((r) => ({
            capture_id: r.capture_id, producer_id: r.producer_id,
            producer_seq: r.producer_seq, api: r.api,
            kind: 'event',
          }));
      const code = [];
      const dir = captureTraceDir(index, captureId);
      for (const row of index.assetRows(captureId)) {
        if (!row.content_path || code.length >= 20) {
          continue;
        }
        const content = path.resolve(dir, row.content_path);
        if (!workspace.contains(content)) {
          continue;
        }
        const text = fs.readFileSync(content, 'utf8');
        const lines = text.split('\n');
        for (let i = 0; i < lines.length && code.length < 20; i++) {
          if (lines[i].includes(param)) {
            code.push({ capture_id: captureId, asset_id: row.asset_id,
                        line: i + 1, kind: 'asset' });
          }
        }
      }
      return [...events, ...code];
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
      const dir = captureTraceDir(index, captureId);
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

  // ---- notes ------------------------------------------------------------
  a.push({
    name: 'notes_get', tier: TIERS.READ_EVIDENCE,
    input: { site: 'string?' },
    output: '.frx-notes.ndjson rows (site filter optional)',
    run: async (args) => {
      const notesPath = path.join(workspace.root, '.frx-notes.ndjson');
      if (!fs.existsSync(notesPath)) {
        return [];
      }
      const rows = fs.readFileSync(notesPath, 'utf8').split('\n')
          .filter((l) => l.trim())
          .map((l) => { try { return JSON.parse(l); } catch { return null; } })
          .filter(Boolean);
      return args && args.site ? rows.filter((r) => r.site === args.site) : rows;
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
    run: async (args, context) => {
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
      void context;
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

  // skill tools operate on workspace skill dirs (skills/ if present)
  for (const [name, op] of [
    ['skill_list', (dir) => listSkills(dir)],
    ['skill_get', (dir, args) => readSkill(dir, args, 'SKILL.md')],
    ['skill_read_resource', (dir, args) => readSkill(dir, args, 'resource')],
  ]) {
    a.push({
      name, tier: TIERS.READ_EVIDENCE,
      input: { name: 'string', offset: 'int?', limit: 'int?' },
      output: 'skill content (paged)',
      run: async (args) => {
        const skillsDir = path.join(workspace.root, 'skills');
        if (!fs.existsSync(skillsDir)) {
          return name === 'skill_list' ? [] : null;
        }
        return op(skillsDir, args || {});
      },
    });
  }

  return a;
}

// ---- helpers --------------------------------------------------------------
function captureRow(index, captureId) {
  const rows = index.listCaptures()
      .filter((r) => r.capture_id === captureId);
  if (!rows.length) {
    throw new Error(`unknown capture: ${captureId}`);
  }
  return rows[0];
}

function captureTraceDir(index, captureId) {
  const row = captureRow(index, captureId);
  return row.dir || row.trace_file || row.dir;
}

function requireString(args, field) {
  const v = args && args[field];
  if (typeof v !== 'string' || !v) {
    throw new Error(`missing required string argument: ${field}`);
  }
  return v;
}

function clampInt(v, lo, hi, dflt) {
  const n = Number(v);
  if (!Number.isFinite(n)) {
    return dflt;
  }
  return Math.max(lo, Math.min(hi, Math.round(n)));
}

function safeRegex(pattern) {
  try {
    return new RegExp(pattern);
  } catch {
    return new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  }
}

function listSkills(dir) {
  return fs.readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => ({ name: e.name }));
}

function readSkill(dir, args, what) {
  const name = requireString(args, 'name');
  const skillDir = path.join(dir, name);
  if (!skillDir.startsWith(dir + path.sep)) {
    throw new Error('skill name escapes the skills directory');
  }
  const file = what === 'resource'
      ? path.join(skillDir, requireString(args, 'resource'))
      : path.join(skillDir, 'SKILL.md');
  if (!file.startsWith(dir + path.sep) || !fs.existsSync(file)) {
    throw new Error(`skill resource not found: ${name}`);
  }
  const text = fs.readFileSync(file, 'utf8');
  const offset = clampInt(args.offset, 0, text.length, 0);
  const limit = clampInt(args.limit, 1, 1 << 18, 1 << 14);
  return { name, path: path.relative(dir, file),
           offset, total: text.length,
           content: text.slice(offset, offset + limit) };
}

module.exports = { createAGroupAdapters };
