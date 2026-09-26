'use strict';
// P6-E3: minimal environment manager (the frozen env-seven:
// open/close/create/list/status/delete/update). An env owns ONE
// profile directory under the workspace; ISOLATION is structural —
// separate directories, one open env at a time. The four
// fingerprint-layer-dependent tools are NOT here (P7; the capability
// list reports them unavailable with the reason).

const fs = require('node:fs');
const path = require('node:path');

function createEnvManager({ workspace }) {
  const root = workspace.dir('profiles');
  const statePath = path.join(root, 'env-state.json');
  let openEnv = null;
  try {
    openEnv = JSON.parse(fs.readFileSync(statePath, 'utf8')).open || null;
  } catch {
    openEnv = null;
  }

  function persist() {
    fs.writeFileSync(statePath, JSON.stringify({ open: openEnv }));
  }

  function envDir(name) {
    if (typeof name !== 'string' || !/^[A-Za-z0-9._-]+$/.test(name)) {
      throw new Error(`invalid env name: ${name}`);
    }
    return path.join(root, name);
  }

  function metaPath(name) {
    return path.join(envDir(name), 'env.json');
  }

  function readMeta(name) {
    return JSON.parse(fs.readFileSync(metaPath(name), 'utf8'));
  }

  function writeMeta(name, meta) {
    fs.mkdirSync(envDir(name), { recursive: true });
    fs.writeFileSync(metaPath(name), JSON.stringify(meta, null, 1));
  }

  return {
    create(name, opts = {}) {
      const dir = envDir(name);
      if (fs.existsSync(metaPath(name))) {
        throw new Error(`env exists: ${name}`);
      }
      fs.mkdirSync(dir, { recursive: true });
      writeMeta(name, {
        name, created_ms: Date.now(),
        notes: opts.notes || '',
        opens: 0,
      });
      return { name, dir };
    },

    list() {
      if (!fs.existsSync(root)) {
        return [];
      }
      return fs.readdirSync(root, { withFileTypes: true })
          .filter((e) => e.isDirectory())
          .map((e) => e.name)
          .filter((n) => fs.existsSync(metaPath(n)))
          .map((n) => {
            const meta = readMeta(n);
            return {
              name: n, open: openEnv === n,
              created_ms: meta.created_ms, notes: meta.notes,
              opens: meta.opens,
            };
          });
    },

    status(name) {
      if (!fs.existsSync(metaPath(name))) {
        return { name, exists: false };
      }
      const meta = readMeta(name);
      return { name, exists: true, open: openEnv === name,
               created_ms: meta.created_ms, opens: meta.opens,
               notes: meta.notes || '',
               profile_dir: envDir(name) };
    },

    update(name, patch = {}) {
      const meta = readMeta(name);
      const allowed = {};
      for (const key of ['notes']) {
        if (key in patch) {
          allowed[key] = String(patch[key]);
        }
      }
      writeMeta(name, { ...meta, ...allowed });
      return this.status(name);
    },

    open(name) {
      if (!fs.existsSync(metaPath(name))) {
        throw new Error(`env not found: ${name}`);
      }
      if (openEnv && openEnv !== name) {
        throw new Error(`env ${openEnv} is already open — close it first`);
      }
      openEnv = name;
      const meta = readMeta(name);
      writeMeta(name, { ...meta, opens: (meta.opens || 0) + 1 });
      persist();
      return this.status(name);
    },

    close(name) {
      if (openEnv !== name) {
        throw new Error(`env ${name} is not open`);
      }
      openEnv = null;
      persist();
      return this.status(name);
    },

    delete(name) {
      if (openEnv === name) {
        throw new Error(`env ${name} is open — close before delete`);
      }
      if (!fs.existsSync(metaPath(name))) {
        throw new Error(`env not found: ${name}`);
      }
      // Boundary: only ever delete inside the profiles root.
      const dir = workspace.assertInside(envDir(name), 'env dir');
      fs.rmSync(dir, { recursive: true, force: true });
      return { name, deleted: true };
    },

    /** The profile dir a browser launch should use (the open env, or
     * null = the Host default). */
    activeProfile() {
      return openEnv ? envDir(openEnv) : null;
    },
    openName: () => openEnv,
  };
}

module.exports = { createEnvManager };
