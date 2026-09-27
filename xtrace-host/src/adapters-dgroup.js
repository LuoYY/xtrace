'use strict';
// M3-E2: the D-group NATIVE track (no frx dependency): fs five +
// scripts_save. Every path goes through workspace.assertInside (the
// realpath gate — never a string prefix); reads are byte-capped with
// offset/limit paging; writes are workspace-bound with parent-dir
// creation and depth limits; scripts_save guards 404/fragment sources.

const fs = require('node:fs');
const path = require('node:path');
const { TIERS } = require('./broker');

const MAX_READ_BYTES = 32768;      // 32KB page per call
const MAX_WRITE_BYTES = 1 << 20;
const MAX_DEPTH = 24;

function createDGroupNativeAdapters({ workspace, host }) {
  const a = [];
  void host;

  const requireString = (args, field) => {
    const v = args && args[field];
    if (typeof v !== 'string' || !v) {
      throw new Error(`missing required string argument: ${field}`);
    }
    return v;
  };
  const resolveInside = (target, what) =>
      workspace.assertInside(target, what);

  function depthOf(target) {
    const rel = path.relative(workspace.root, target);
    if (!rel) {
      return 0;
    }
    return rel.split(path.sep).length;
  }

  a.push({
    name: 'fs_list', tier: TIERS.READ_EVIDENCE,
    input: { dir: 'string?' },
    output: 'entries with kinds (bounded to 200)',
    run: async (args) => {
      const dir = args && args.dir
          ? resolveInside(path.resolve(workspace.root, args.dir), 'fs dir')
          : workspace.root;
      const out = [];
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        out.push({ name: e.name,
                   kind: e.isDirectory() ? 'dir' : 'file' });
        if (out.length >= 200) {
          break;
        }
      }
      return { dir, entries: out };
    },
  });

  a.push({
    name: 'fs_read', tier: TIERS.READ_EVIDENCE,
    input: { path: 'string', offset: 'int?', limit: 'int?' },
    output: 'content page (<=32KB, BYTE-exact slicing — a page can ' +
            'cut a multi-byte UTF-8 sequence; reassemble pages before ' +
            'decoding) with truncated flag + total bytes',
    run: async (args) => {
      const file = resolveInside(
          path.resolve(workspace.root, requireString(args, 'path')),
          'fs_read target');
      const stat = fs.statSync(file);
      if (!stat.isFile()) {
        throw new Error(`not a file: ${file}`);
      }
      const max = Math.min(
          Number(args.limit) > 0 ? Number(args.limit) : MAX_READ_BYTES,
          MAX_READ_BYTES);
      const offset = Number(args.offset) >= 0 ? Number(args.offset) : 0;
      if (offset >= stat.size) {
        return { path: file, offset, total_bytes: stat.size,
                 content: '', truncated: false, eof: true };
      }
      const fd = fs.openSync(file, 'r');
      try {
        const take = Math.min(max, stat.size - offset);
        const buf = Buffer.allocUnsafe(take);
        fs.readSync(fd, buf, 0, take, offset);
        return { path: file, offset, total_bytes: stat.size,
                 content: buf.toString('utf8'),
                 truncated: offset + take < stat.size,
                 eof: offset + take >= stat.size };
      } finally {
        fs.closeSync(fd);
      }
    },
  });

  a.push({
    name: 'fs_write', tier: TIERS.READ_EVIDENCE,
    input: { path: 'string', content: 'string', append: 'bool?' },
    output: 'bytes written + mode',
    sideEffects: 'workspace-bound file write',
    run: async (args) => {
      const target = resolveInside(
          path.resolve(workspace.root, requireString(args, 'path')),
          'fs_write target');
      if (depthOf(target) > MAX_DEPTH) {
        throw new Error(`path too deep (>${MAX_DEPTH})`);
      }
      const content = String(args.content ?? '');
      if (Buffer.byteLength(content, 'utf8') > MAX_WRITE_BYTES) {
        throw new Error(`content exceeds ${MAX_WRITE_BYTES} bytes`);
      }
      fs.mkdirSync(path.dirname(target), { recursive: true });
      if (args.append) {
        fs.appendFileSync(target, content);
      } else {
        fs.writeFileSync(target, content);
      }
      return { path: target,
               bytes: Buffer.byteLength(content, 'utf8'),
               appended: Boolean(args.append) };
    },
  });

  a.push({
    name: 'fs_mkdir', tier: TIERS.READ_EVIDENCE,
    input: { path: 'string' },
    output: 'created dir',
    sideEffects: 'workspace-bound directory creation',
    run: async (args) => {
      const target = resolveInside(
          path.resolve(workspace.root, requireString(args, 'path')),
          'fs_mkdir target');
      fs.mkdirSync(target, { recursive: true });
      return { path: target };
    },
  });

  a.push({
    name: 'fs_copy', tier: TIERS.READ_EVIDENCE,
    input: { from: 'string', to: 'string' },
    output: 'bytes copied',
    sideEffects: 'workspace-bound copy',
    run: async (args) => {
      const from = resolveInside(
          path.resolve(workspace.root, requireString(args, 'from')),
          'fs_copy source');
      const to = resolveInside(
          path.resolve(workspace.root, requireString(args, 'to')),
          'fs_copy target');
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(from, to);
      return { from, to, bytes: fs.statSync(to).size };
    },
  });

  a.push({
    name: 'scripts_save', tier: TIERS.STATEFUL_CONTROL,
    input: { script_id: 'string', url: 'string?' },
    output: 'saved source + integrity verdict (404/fragment guarded)',
    sideEffects: 'fetches Debugger.getScriptSource via the host and writes the workspace copy',
    available: () => Boolean(host && !host.closed),
    unavailableReason: 'needs a live browser connection (host)',
    run: async (args) => {
      const scriptId = requireString(args, 'script_id');
      // R1-1: Debugger.* is SESSION-scoped — the browser-level send
      // gets "wasn't found" 100% of the time, and script ids live in
      // the ISOLATE that parsed them. The tool walks the LIVE page
      // targets (no new page created, no navigation — the parsing
      // context already exists), attaches, enables Debugger, and takes
      // the first target that knows the id; an optional url narrows
      // the walk. A url that matches no live target loads it once as a
      // fallback (so the operator can save by url + id after the fact).
      const targetUrl = args.url || '';
      const { targetInfos } = await host.send('Target.getTargets', {});
      const pages = (targetInfos || []).filter((t) => t.type === 'page');
      const ordered = targetUrl
          ? [...pages.filter((t) => (t.url || '') === targetUrl),
             ...pages.filter((t) => (t.url || '') !== targetUrl)]
          : pages;
      let source = null;
      let usedSession = null;
      // Debugger.getScriptSource returns { scriptSource: "..." } (older
      // paths returned a bare string) — normalize both.
      const normalize = (out) => {
        if (typeof out === 'string') {
          return out;
        }
        if (out && typeof out === 'object' &&
            typeof out.scriptSource === 'string') {
          return out.scriptSource;
        }
        return null;
      };
      for (const page of ordered) {
        try {
          const { sessionId } = await host.send('Target.attachToTarget',
              { targetId: page.targetId, flatten: true });
          await host.send('Debugger.enable', {}, sessionId);
          const out = normalize(await host.send(
              'Debugger.getScriptSource', { scriptId }, sessionId));
          if (out !== null && out.length > 0) {
            source = out;
            usedSession = sessionId;
            break;
          }
        } catch {
          // this target does not know the script id — try the next
        }
      }
      if (source === null && targetUrl) {
        // fallback: load the url fresh so its isolate parses the script
        const { targetId } = await host.send('Target.createTarget',
            { url: targetUrl });
        try {
          const { sessionId } = await host.send('Target.attachToTarget',
              { targetId, flatten: true });
          await host.send('Debugger.enable', {}, sessionId);
          await new Promise((r) => setTimeout(r, 600));
          const out = normalize(await host.send(
              'Debugger.getScriptSource', { scriptId }, sessionId));
          if (out !== null && out.length > 0) {
            source = out;
            usedSession = sessionId;
          }
        } catch {
          // fall through to the 404 below
        } finally {
          await host.send('Target.closeTarget', { targetId })
              .catch(() => {});
        }
      }
      if (source === null) {
        throw new Error(`404 script: ${scriptId}`);
      }
      {
        const integrity = {
          bytes: source.length,
          looks_fragment: source.length > 0 && source.length < 16,
          empty: source.length === 0,
        };
        const file = path.join(workspace.dir('scripts'),
            `${scriptId.replace(/[^A-Za-z0-9._-]/g, '_')}.js`);
        workspace.assertInside(file, 'scripts_save target');
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, source);
        return { script_id: scriptId, url: args.url || null,
                saved: file, integrity };
      }
      void usedSession;
    },
  });

  return a;
}

module.exports = { createDGroupNativeAdapters, MAX_READ_BYTES };
