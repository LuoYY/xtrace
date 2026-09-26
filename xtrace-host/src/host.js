'use strict';
// P6-R1 (R1-1): the Host COMPOSITION ROOT — the single place the
// product assembles its object graph. createHost() builds the
// workspace, the Broker, the env manager, the derived index and the
// registered adapter set, and exposes host.callTool(). UI, drivers and
// any future MCP entry consume ONLY this root (source-shape gate:
// createBroker( call sites = composition root + unit tests).
//
// The Host also owns the LAUNCH SPEC (M8/R1-2): one canonical browser
// argument list (precise environment: causality=sync + observer +
// tier-lock js-flags) consumed by every launch path, with the env
// manager's active profile feeding --user-data-dir (M2: activeProfile
// finally has a consumer). Pipe closed => the browser is gone; NO
// reconnect in P6 — adoptOrTerminate() is the §5.4 restart entry.

const fs = require('node:fs');
const path = require('node:path');
const { launchBrowser } = require('./cdp');
const { createBroker } = require('./broker');
const { createWorkspace } = require('./workspace');
const { createEnvManager } = require('./env-manager');
const { createEvidenceIndex } = require('./evidence-index');
const { createAGroupAdapters } = require('./adapters-agroup');
const { createBGroupAdapters } = require('./adapters-bgroup');
const { createDGroupNativeAdapters } = require('./adapters-dgroup');
const { createCGroupAdapters } = require('./adapters-cgroup');
const { createFrxTrackAdapters } = require('./adapters-frx-track');
const { createDisclosedUnavailableAdapters }
  = require('./adapters-disclosed');
const { createExecutors } = require('./executors');
const { negotiate } = require('./capabilities');

/** THE launch spec (single source, M8): every browser this Host owns
 * runs with the precise-environment flags the B-group tools require.
 * The transport flags (headless/remote-debugging-pipe/no-first-run)
 * belong to launchBrowser; this list is the OBSERVATION contract. */
function buildLaunchSpec({ traceFile, profileDir, extraArgs = [] }) {
  const args = [
    `--user-data-dir=${profileDir}`,
    '--xtrace-causality=sync', '--xtrace-ignition-observer',
    '--js-flags=--allow-natives-syntax --max-opt=0',
  ];
  if (traceFile) {
    args.push('--xtrace-enable', `--xtrace-file=${traceFile}`);
  }
  return [...args, ...extraArgs];
}

async function createHost({
  executable,
  browserArgs = [],
  workspaceRoot,
  env = process.env,
  cwd,
  policy,
  traceFile = null,
  skipBrowserLaunch = false,
  launchBrowserImpl = launchBrowser,
}) {
  const workspace = createWorkspace(workspaceRoot);
  const broker = createBroker({ workspace, policy });
  const envs = createEnvManager({ workspace });
  const index = createEvidenceIndex(
      path.join(workspace.dir('index'), 'index.db'));
  index.rebuildFromDir(workspace.dir('traces'));

  // The env manager's active profile feeds the launch spec (M2).
  const profileDir = envs.activeProfile() ||
      path.join(workspace.dir('profiles'), '_default');
  fs.mkdirSync(profileDir, { recursive: true });
  const resolvedTrace = traceFile ? path.resolve(String(traceFile)) : null;
  if (resolvedTrace) {
    fs.mkdirSync(path.dirname(resolvedTrace), { recursive: true });
  }

  let launched = null;
  let connection = null;
  if (!skipBrowserLaunch) {
    // The observation spec ALWAYS applies (M8: single source); caller
    // browserArgs may only ADD (e.g. a start URL), never replace it.
    const launchArgs = [...buildLaunchSpec({
      traceFile: resolvedTrace, profileDir }), ...browserArgs];
    launched = await launchBrowserImpl({
      executable,
      args: launchArgs,
      env, cwd,
      stderr: fs.openSync(
          path.join(workspace.dir('ledger'), 'browser-stderr.log'), 'a'),
    });
    connection = launched.connection;
  }

  const host = {
    workspace, broker, envs, index,
    executable,
    version: launched ? launched.version : null,
    browserPid: launched ? launched.child.pid : null,   // M3-E4
    traceFile: resolvedTrace,
    profileDir,
    closed: false,

    send(method, params, sessionId) {
      if (host.closed || !connection) {
        return Promise.reject(new Error('CDP connection closed (host)'));
      }
      return connection.send(method, params, sessionId);
    },
    onEvent(handler) {
      if (connection) {
        connection.on('event', handler);
      }
    },

    /** Rebuild the derived index from the traces root (acceptance path
     * unchanged; also the post-restart adoption substrate). */
    reindex() {
      return index.rebuildFromDir(workspace.dir('traces'));
    },

    /** Negotiated three-state capability list (R1-9 surface). */
    async capabilities() {
      let caps = null;
      if (!connection) {
        caps = { hasXTraceDomain: false,
                 probeError: 'host launched without a browser' };
      } else {
        try {
          const raw = await connection.send('XTrace.getCapabilities');
          caps = { hasXTraceDomain: true, raw };
        } catch (error) {
          const noDomain = /not found|unknown|does not exist/i
              .test(String(error.message));
          caps = { hasXTraceDomain: !noDomain,
                   probeError: String(error.message) };
        }
      }
      const negotiated = negotiate({ browserCapabilities: caps,
                                     adapters: host.adapters.all() });
      host.capabilitySnapshot = negotiated;
      return negotiated;
    },

    /** Tool schemas WITH negotiated state/reason (R1-9). Unavailable
     * tools are excluded from the model surface and reported in the
     * capability list instead. */
    async toolSchemas() {
      const negotiated = await host.capabilities();
      return negotiated.tools
          .filter((t) => t.state !== 'unavailable')
          .map((t) => ({
            name: t.name, tier: t.tier, input: t.input, output: t.output,
            state: t.state, reason: t.reason || undefined,
            sideEffects: t.sideEffects || 'none',
          }));
    },

    /** The ONLY way anything executes a tool (B1: UI included). */
    async callTool(name, args, context) {
      const tool = host.tools.get(name);
      if (!tool) {
        throw new Error(`unknown tool: ${name}`);
      }
      return broker.execute(tool, args || {}, context || { origin: 'ui' });
    },

    async close() {
      if (host.closed) {
        return;
      }
      host.closed = true;
      if (connection) {
        try {
          await connection.send('Browser.close');
        } catch {
          // pipe already gone — the browser exited on its own
        }
      }
      index.close();
    },
  };

  // Registered adapter set — built AFTER `host` exists so B-group tools
  // can hold the live host reference.
  // M3-E6 (PD4): the adapter set handed OUT of the composition root
  // is BROKER-BOUND — negotiation/matrix consumers see descriptor rows
  // WITHOUT a callable .run. The only execution path is callTool.
  host.adapters = (() => {
    const adapters = [
      ...createAGroupAdapters({ workspace, index, host }),
      ...createBGroupAdapters({ workspace, host, envs }),
      ...createCGroupAdapters({ workspace, host }),
      ...createDGroupNativeAdapters({ workspace, host }),
      ...createFrxTrackAdapters(),
      ...createDisclosedUnavailableAdapters(),
      ...(policy && policy.hostExecPolicy
          ? createExecutors({ workspace }) : []),
    ];
    host.tools = new Map();
    for (const adapter of adapters) {
      host.tools.set(adapter.name, broker.register(adapter));
    }
    const bound = (adapter) => {
      // strip every callable: the returned row is a DESCRIPTOR
      const { run, available, ...rest } = adapter;
      void run; void available;
      return rest;
    };
    return {
      all: () => adapters.map(bound),
      get: (name) => host.tools.get(name),   // internal use only
    };
  })();

  if (connection) {
    connection.on('closed', () => {
      host.closed = true;
    });
  }
  return host;
}

/** Post-restart orphan resolution (frozen decision: exactly one of
 * read-only adoption or termination) — the REAL §5.4 entry, called by
 * the UI's resume flow; index re-ingest implements the adoption. */
function resolveOrphan({ pid, traceDir, index, kill = (p) =>
        process.kill(p, 'SIGTERM'), pidAlive = (p) => {
      try { process.kill(p, 0); return true; } catch { return false; }
    } }) {
  const manifestPath = path.join(traceDir, 'trace.manifest.json');
  let settled = false;
  let terminal = 'unknown';
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    terminal = (manifest.terminal && manifest.terminal.state) || 'unknown';
    settled = true;
  } catch {
    settled = fs.existsSync(manifestPath); // v1/v2-era products count
  }
  const alive = pid != null && pidAlive(pid);
  if (!alive) {
    return { action: 'adopt-read-only',
             reason: `pid ${pid} not alive; artifacts persist`, terminal };
  }
  if (settled) {
    return { action: 'adopt-read-only',
             reason: `manifest settled (terminal=${terminal}); capture ` +
                     `already ended`, terminal };
  }
  kill(pid);
  return { action: 'terminated',
           reason: 'live pid with unsettled manifest — terminated per ' +
                   'no-reconnect policy', terminal };
}

module.exports = { createHost, resolveOrphan, buildLaunchSpec };
