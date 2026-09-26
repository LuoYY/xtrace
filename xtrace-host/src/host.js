'use strict';
// P6-E1: the Agent Host — browser ownership plus the frozen
// process-ownership decision (handoff §5.4): pipe closed => browser
// exited; NO reconnect semantics in P6. After a Host restart the
// on-disk artifacts persist; the caller picks ONE of:
//   adoptReadOnly(traceDir)  — read products, no capture continuation
//   terminateOrphan(pid, traceDir) — pid liveness + manifest state
//       decide termination (a LIVE pid whose manifest is not settled
//       may be terminated; a settled manifest means it already ended).

const fs = require('node:fs');
const path = require('node:path');
const { launchBrowser } = require('./cdp');
const { createBroker } = require('./broker');
const { createWorkspace } = require('./workspace');
const { registry } = require('./capabilities');

async function createHost({
  executable,
  browserArgs = [],
  workspaceRoot,
  env = process.env,
  cwd,
  policy,
  traceFile = null,
}) {
  const workspace = createWorkspace(workspaceRoot);
  const broker = createBroker({ workspace, policy });
  const adapters = registry();
  const stderrPath = path.join(workspace.dir('ledger'), 'browser-stderr.log');
  const stderr = fs.openSync(stderrPath, 'a');

  const launched = await launchBrowser({
    executable, args: browserArgs, env, cwd, stderr,
  });
  const host = {
    workspace,
    broker,
    adapters,
    child: launched.child,
    version: launched.version,
    traceFile: traceFile ? path.resolve(String(traceFile)) : null,
    send: (method, params, sessionId) => {
      if (host.closed) {
        return Promise.reject(new Error('CDP connection closed (host)'));
      }
      return launched.connection.send(method, params, sessionId);
    },
    onEvent: (handler) => launched.connection.on('event', handler),
    closed: false,

    async capabilities() {
      let caps = null;
      try {
        const raw = await launched.connection.send('XTrace.getCapabilities');
        caps = { hasXTraceDomain: true, raw };
      } catch (error) {
        const noDomain = /not found|unknown|does not exist/i.test(String(error.message));
        caps = { hasXTraceDomain: !noDomain, probeError: String(error.message) };
      }
      return adapters.negotiate(caps);
    },

    /** Terminate the owned browser and mark the Host closed. The pipe
     * closing on its own also flips closed (no reconnect). */
    async close() {
      if (host.closed) {
        return;
      }
      host.closed = true;
      try {
        await launched.connection.send('Browser.close');
      } catch {
        // pipe already gone — the browser exited on its own
      }
    },
  };

  launched.connection.on('closed', () => {
    host.closed = true;
  });
  launched.connection.once('closed', () => host.onPipeLost
      ? host.onPipeLost()
      : null);
  return host;
}

/** Post-restart orphan resolution (frozen decision: exactly one of
 * read-only adoption or termination). */
function resolveOrphan({ pid, traceDir, kill = (p) => process.kill(p, 'SIGTERM'),
                          pidAlive = (p) => { try { process.kill(p, 0); return true; }
                                              catch { return false; } } }) {
  const manifestPath = path.join(traceDir, `${path.basename(traceDir, '.ndjson')}.manifest.json`);
  let settled = false;
  let terminal = 'unknown';
  try {
    const manifest = JSON.parse(fs.readFileSync(
        path.join(traceDir, 'trace.manifest.json'), 'utf8'));
    terminal = (manifest.terminal && manifest.terminal.state) || 'unknown';
    settled = terminal !== 'unknown';
  } catch {
    settled = fs.existsSync(manifestPath); // v1/v2-era products count as settled artifacts
  }
  const alive = pid != null && pidAlive(pid);
  if (!alive) {
    return { action: 'adopt-read-only', reason: `pid ${pid} not alive; artifacts persist`, terminal };
  }
  if (settled) {
    return { action: 'adopt-read-only',
             reason: `manifest settled (terminal=${terminal}); capture already ended`, terminal };
  }
  kill(pid);
  return { action: 'terminated',
           reason: 'live pid with unsettled manifest — terminated per no-reconnect policy',
           terminal };
}

module.exports = { createHost, resolveOrphan };
