'use strict';
// P6-E1: workspace layout and trust boundaries.
//
// The workspace owns everything an Agent session may read or write:
//   <root>/traces/<captureId>/     — trace dirs (NDJSON + manifest + assets)
//   <root>/ledger/                 — Broker audit ledger (append-only JSONL)
//   <root>/index/index.db          — derived evidence index (E2)
//   <root>/profiles/               — browser profiles (env_*, E3)
//
// Boundary rule: a target path is INSIDE the workspace only after
// realpath() resolution — a symlink that escapes the root is OUTSIDE,
// and string-prefix checks are explicitly not used (draft §11.2: "不能
// 只做字符串前缀检查").

const fs = require('node:fs');
const path = require('node:path');

const LAYOUT = {
  traces: 'traces',
  ledger: 'ledger',
  index: 'index',
  profiles: 'profiles',
  scripts: 'scripts',   // M3-E2: Debugger.getScriptSource drops
};

function createWorkspace(root) {
  const resolvedRoot = fs.realpathSync(path.resolve(root));
  for (const dir of Object.values(LAYOUT)) {
    fs.mkdirSync(path.join(resolvedRoot, dir), { recursive: true });
  }
  return {
    root: resolvedRoot,
    dir(name) {
      if (!(name in LAYOUT)) {
        throw new Error(`unknown workspace dir: ${name}`);
      }
      return path.join(resolvedRoot, LAYOUT[name]);
    },
    /** Realpath-resolved containment check. False for missing paths
     * OUTSIDE the root; a missing path inside is checked against its
     * deepest existing ancestor's realpath (symlinks resolve there). */
    contains(target) {
      const absolute = path.resolve(resolvedRoot, target);
      let probe = absolute;
      const stack = [];
      while (!fs.existsSync(probe)) {
        stack.push(path.basename(probe));
        probe = path.dirname(probe);
        if (probe === path.dirname(probe)) {
          return false; // reached the filesystem root without a match
        }
      }
      const real = fs.realpathSync(probe);
      const joined = real + (stack.length ? path.sep + stack.reverse().join(path.sep) : '');
      const rel = path.relative(resolvedRoot, joined);
      return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
    },
    /** Rejects unless the realpath-resolved target is inside the
     * workspace — the single gate every read/write passes. */
    assertInside(target, what = 'path') {
      if (!this.contains(target)) {
        const err = new Error(
            `${what} escapes the workspace boundary (realpath): ${target}`);
        err.code = 'WORKSPACE_BOUNDARY';
        throw err;
      }
      return path.resolve(resolvedRoot, target);
    },
  };
}

module.exports = { createWorkspace, LAYOUT };
