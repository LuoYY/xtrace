'use strict';
// P6-E3: minimal environment manager (the frozen env-seven:
// open/close/create/list/status/delete/update). An env owns ONE
// profile directory under the workspace; ISOLATION is structural —
// separate directories, one open env at a time. The four
// fingerprint-layer-dependent tools are NOT here (P7; the capability
// list reports them unavailable with the reason).

const fs = require('node:fs');
const path = require('node:path');

// M3-E4: an instance row tracks ONE owned browser process per env —
// pid, port, state (launching|running|stopped|port-conflict), and the
// exec -a process title. Fingerprint mounting is M5: the field is
// RESERVED (recorded, never interpreted here).
function createEnvManager({ workspace,
                           killImpl = (p, s) => process.kill(p, s),
                           pidAliveImpl = (p) => {
                             try { process.kill(p, 0); return true; }
                             catch { return false; }
                           } }) {
  const root = workspace.dir('profiles');
  const statePath = path.join(root, 'env-state.json');
  let openEnv = null;
  try {
    openEnv = JSON.parse(fs.readFileSync(statePath, 'utf8')).open || null;
  } catch {
    openEnv = null;
  }
  // envName -> instance row (M3-E4: instance ownership)
  const instances = new Map();

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
        // M5 mount point RESERVED: recorded verbatim, never
        // interpreted by M3 (fingerprint semantics land in M5).
        fingerprint: opts.fingerprint || null,
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

    // ---- M3-E4: instance ownership + port lifecycle -----------------

    /** Probe whether a TCP port is bindable RIGHT NOW (real bind
     * attempt on 127.0.0.1; closed immediately). */
    async probePort(port) {
      const net = require('node:net');
      return await new Promise((resolve) => {
        const srv = net.createServer();
        srv.once('error', () => resolve(false));
        srv.listen(port, '127.0.0.1', () => srv.close(
            () => resolve(true)));
      });
    },

    /** Claim a free port for an env instance (scan from `from`).
     * Returns { port, conflict } — a conflict row names the env that
     * already holds the port (state machine: port-conflict).
     * ADVISORY ONLY (architect R1.5-2): the pipe transport consumes
     * no ports; this neither holds nor registers the port — re-eval
     * when the reconnect transport lands. */
    async claimPort(envName, { from = 9300, tries = 40 } = {}) {
      for (const [name, inst] of instances) {
        if (inst.port && !inst.stopped) {
          return { port: null,
                   conflict: { env: name, port: inst.port },
                   state: 'port-conflict' };
        }
        void envName;
      }
      for (let p = from; p < from + tries; p++) {
        if (await this.probePort(p)) {
          return { port: p, conflict: null, state: 'port-reserved' };
        }
      }
      return { port: null, conflict: null, state: 'no-free-port' };
    },

    /** Register the RUNNING instance for an env (idempotent per env:
     * a second registration for a live env is rejected). */
    registerInstance(envName, { pid, port, argv0 }) {
      const existing = instances.get(envName);
      if (existing && !existing.stopped && pidAliveImpl(existing.pid)) {
        return { ok: false,
                 reason: 'env already owns a live instance',
                 pid: existing.pid };
      }
      instances.set(envName, { pid, port, argv0,
                               stopped: false,
                               registered_ms: Date.now() });
      return { ok: true,
               instance: { pid, port, argv0 } };
    },

    /** Instance row incl. live process check. */
    instanceStatus(envName) {
      const inst = instances.get(envName);
      if (!inst) {
        return { env: envName, state: 'no-instance' };
      }
      const alive = pidAliveImpl(inst.pid);
      return { env: envName, pid: inst.pid, port: inst.port,
               argv0: inst.argv0,
               state: inst.stopped ? 'stopped'
                   : alive ? 'running' : 'stopped(dead-process)',
               alive };
    },

    /** Terminate the env's instance (SIGTERM then SIGKILL). The state
     * machine transition is recorded whether or not the pid answers. */
    terminateInstance(envName) {
      const inst = instances.get(envName);
      if (!inst) {
        return { ok: false, reason: 'no-instance' };
      }
      if (!inst.stopped && pidAliveImpl(inst.pid)) {
        try { killImpl(inst.pid, 'SIGTERM'); } catch { /* racing exit */ }
        if (pidAliveImpl(inst.pid)) {
          try { killImpl(inst.pid, 'SIGKILL'); } catch { /* exited */ }
        }
      }
      inst.stopped = true;
      return { ok: true, state: 'stopped', pid: inst.pid };
    },

    /** All instance rows (the parallel-env gate iterates this). */
    allInstances() {
      return [...instances.keys()].map((n) => this.instanceStatus(n));
    },
  };
}

module.exports = { createEnvManager };
