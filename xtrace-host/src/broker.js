'use strict';
// P6-E1: the authorization Broker — the SINGLE entry every tool
// execution passes through, whoever the caller is (Agent loop, UI, MCP
// server). Draft §11.2: the original direct-callTool paths could bypass
// confirmation; here there is no bypass because there is no other path.
//
// Three frozen tiers (handoff §5.2):
//   read-evidence   (A-group)      session-scoped grant, no per-call UI
//   stateful-control (B-group)     per-call confirmation + reason
//                                  string + audit entry
//   host-exec       (D-group; NOT registered in P6, shape reserved)
//                                  per-call confirmation + default-deny
//                                  policy whitelist (paths/network/deps)
//
// The audit ledger is append-only JSONL in the workspace; every
// decision — granted, denied, or confirmed — lands in it.

const fs = require('node:fs');
const path = require('node:path');

const TIERS = Object.freeze({
  READ_EVIDENCE: 'read-evidence',
  STATEFUL_CONTROL: 'stateful-control',
  HOST_EXEC: 'host-exec',
});

function createBroker({ workspace, policy, clock = () => Date.now() }) {
  // policy: {
  //   hostExecWhitelist: { paths: [], network: [], deps: [] },  // default-deny
  //   allowUnconfirmedReads: true,                                // A-group session grant
  // }
  const effectivePolicy = {
    allowUnconfirmedReads: true,
    hostExecWhitelist: { paths: [], network: [], deps: [] },
    ...(policy || {}),
  };

  const ledgerPath = path.join(workspace.dir('ledger'),
                               `broker-${clock()}.jsonl`);
  // Pending confirmations keyed by (tool|origin|reason) so the id a UI
  // saw from gate() is the SAME entry execute() waits on — no
  // millisecond-collision luck.
  const pending = new Map(); // entryKey -> {id, resolve, toolName, toolTier, origin}

  function audit(entry) {
    const row = JSON.stringify({ ...entry, wall_ms: clock() }) + '\n';
    fs.appendFileSync(ledgerPath, row);
  }

  function register(tool) {
    if (!tool || typeof tool.name !== 'string' || !tool.name) {
      throw new Error('tool registration requires a name');
    }
    if (!Object.values(TIERS).includes(tool.tier)) {
      throw new Error(`tool ${tool.name} has unknown tier ${tool.tier}`);
    }
    if (tool.tier === TIERS.HOST_EXEC) {
      // P6 frozen scope: the SHAPE exists, nothing registers into it.
      throw new Error(
          `tool ${tool.name}: host-exec tier is reserved and not ` +
          `registrable in P6 (default-deny)`);
    }
    return tool;
  }

  /** Gate a request BEFORE execution. Returns one of:
   *  {decision:'granted'} | {decision:'confirmation-required', id} |
   *  {decision:'denied', reason}. Every decision is audited. */
  function gate(toolName, toolTier, context) {
    const origin = context && context.origin ? context.origin : 'unknown';
    if (toolTier === TIERS.READ_EVIDENCE) {
      if (effectivePolicy.allowUnconfirmedReads) {
        audit({ tool: toolName, tier: toolTier, origin,
                decision: 'granted', basis: 'session-grant' });
        return { decision: 'granted' };
      }
      audit({ tool: toolName, tier: toolTier, origin,
              decision: 'denied', reason: 'read-grant-revoked' });
      return { decision: 'denied', reason: 'read-grant-revoked' };
    }
    if (toolTier === TIERS.STATEFUL_CONTROL) {
      const reason = context && context.reason;
      if (typeof reason !== 'string' || reason.trim().length < 3) {
        audit({ tool: toolName, tier: toolTier, origin,
                decision: 'denied', reason: 'missing-reason-string' });
        return { decision: 'denied',
                 reason: 'stateful control requires a reason string' };
      }
      const key = `${toolName}|${origin}|${reason}`;
      let entry = pending.get(key);
      if (!entry) {
        entry = {
          id: `confirm-${toolName}-${clock()}-${pending.size}`,
          resolve: null, toolName, toolTier, origin,
        };
        pending.set(key, entry);
      }
      audit({ tool: toolName, tier: toolTier, origin,
              decision: 'confirmation-required', reason });
      return { decision: 'confirmation-required', id: entry.id, reason };
    }
    // HOST_EXEC: reserved tier — default deny.
    audit({ tool: toolName, tier: toolTier, origin,
            decision: 'denied', reason: 'host-exec-reserved-default-deny' });
    return { decision: 'denied', reason: 'host-exec tier not enabled in P6' };
  }

  /** The UI side resolves a confirmation request: approve/deny once. */
  function resolveConfirmation(id, approved) {
    for (const [key, entry] of pending) {
      if (entry.id === id) {
        pending.delete(key);
        audit({ tool: entry.toolName, tier: entry.toolTier,
                origin: entry.origin,
                decision: approved ? 'confirmed' : 'denied-by-user' });
        if (entry.resolve) {
          entry.resolve(approved);
        }
        return true;
      }
    }
    return false;
  }

  /** The single execution entry. Caller supplies a pre-registered tool
   * (name, tier, run). Agent, UI and MCP all land here — there is no
   * second path around the gate. */
  async function execute(tool, args, context) {
    const g = gate(tool.name, tool.tier, context);
    if (g.decision === 'denied') {
      const err = new Error(`broker denied ${tool.name}: ${g.reason}`);
      err.code = 'BROKER_DENIED';
      throw err;
    }
    if (g.decision === 'confirmation-required') {
      const key = `${tool.name}|${(context && context.origin) || 'unknown'}|${(context && context.reason) || ''}`;
      const entry = pending.get(key);
      const approved = await new Promise((resolve) => {
        entry.resolve = resolve;
      });
      if (!approved) {
        const err = new Error(`broker: ${tool.name} denied by user`);
        err.code = 'BROKER_DENIED';
        throw err;
      }
    }
    const started = clock();
    try {
      const result = await tool.run(args, context);
      audit({ tool: tool.name, tier: tool.tier,
              origin: context && context.origin,
              decision: 'executed', duration_ms: clock() - started });
      return result;
    } catch (error) {
      audit({ tool: tool.name, tier: tool.tier,
              origin: context && context.origin,
              decision: 'execution-failed', error: String(error.message) });
      throw error;
    }
  }

  return {
    TIERS,
    register,
    gate,
    execute,
    resolveConfirmation,
    audit,
    ledgerPath,
    pendingCount: () => pending.size,
    pendingIds: () => [...pending.values()].map((e) => e.id),
  };
}

module.exports = { createBroker, TIERS };
