'use strict';
// P6-R1 (R1-3/R1-4): the authorization Broker — the SINGLE entry every
// tool execution passes through, whoever the caller is (Agent loop, UI,
// MCP). R1 hardening over the E1 design:
//
//   * READ tier grants carry an audit row (basis 'session-grant').
//   * STATEFUL tier: per-call confirmation with a REAL lifecycle —
//     entries have created/expires/owner; late approvals on expired
//     entries are refused (audit 'confirmation-expired'), the same-key
//     second concurrent call is explicitly rejected (no silent
//     orphaning), and cancelPending() lets loops/timeout paths retire
//     their requests.
//   * Audit rows carry an honest `basis`: 'session-grant' (read),
//     'ui-direct-click' (the user's own click IS the confirmation,
//     R1.6-D1), 'human-approved'/'human-denied' (the pending-queue
//     surface answered). Bare 'confirmed' is never written without one.
//   * HOST_EXEC stays default-deny and non-registrable in P6.
//
// resolveConfirmation() must ONLY be called by the confirmation IPC
// handler in the GUI main process (statically asserted by the R1 gate).

const fs = require('node:fs');
const path = require('node:path');

const TIERS = Object.freeze({
  READ_EVIDENCE: 'read-evidence',
  STATEFUL_CONTROL: 'stateful-control',
  HOST_EXEC: 'host-exec',
});

const BASES = Object.freeze({
  SESSION_GRANT: 'session-grant',
  UI_DIRECT_CLICK: 'ui-direct-click',
  HUMAN_APPROVED: 'human-approved',
  HUMAN_DENIED: 'human-denied',
});

const DEFAULT_CONFIRMATION_TTL_MS = 60000;

function createBroker({ workspace, policy, clock = () => Date.now(),
                        confirmationTtlMs = DEFAULT_CONFIRMATION_TTL_MS }) {
  const effectivePolicy = {
    allowUnconfirmedReads: true,
    hostExecWhitelist: { paths: [], network: [], deps: [] },
    ...(policy || {}),
  };

  const ledgerPath = path.join(workspace.dir('ledger'),
                               `broker-${clock()}.jsonl`);
  // entryKey `${tool}|${origin}|${reason}` -> entry
  const pending = new Map();

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
      throw new Error(
          `tool ${tool.name}: host-exec tier is reserved and not ` +
          `registrable in P6 (default-deny)`);
    }
    return tool;
  }

  function entryKey(toolName, origin, reason) {
    return `${toolName}|${origin}|${reason}`;
  }

  /** Read-tier gate: one granted row per call (B1: read entries are
   * audited too, session-scope, no per-call UI). */
  function gateRead(toolName, origin) {
    if (effectivePolicy.allowUnconfirmedReads) {
      audit({ tool: toolName, tier: TIERS.READ_EVIDENCE, origin,
              decision: 'granted', basis: BASES.SESSION_GRANT });
      return { decision: 'granted' };
    }
    audit({ tool: toolName, tier: TIERS.READ_EVIDENCE, origin,
            decision: 'denied', reason: 'read-grant-revoked' });
    return { decision: 'denied', reason: 'read-grant-revoked' };
  }

  /** Stateful-tier gate: create (or reuse) the confirmation entry with
   * a real lifetime. UI-direct clicks may self-confirm via basisHint
   * (R1.6-D1); agent/mcp origins never self-confirm here. */
  function gateStateful(toolName, origin, reason, basisHint) {
    if (typeof reason !== 'string' || reason.trim().length < 3) {
      audit({ tool: toolName, tier: TIERS.STATEFUL_CONTROL, origin,
              decision: 'denied', reason: 'missing-reason-string' });
      return { decision: 'denied',
               reason: 'stateful control requires a reason string' };
    }
    const key = entryKey(toolName, origin, reason);
    const existing = pending.get(key);
    if (existing && clock() >= existing.expires_ms) {
      retireExpired(existing, key);
    } else if (existing && !basisHint) {
      // R1-4: a second concurrent caller on the same key is EXPLICITLY
      // rejected — never silently orphaned.
      audit({ tool: toolName, tier: TIERS.STATEFUL_CONTROL, origin,
              decision: 'denied', reason: 'duplicate-confirmation-pending',
              confirmation_id: existing.id });
      return { decision: 'denied',
               reason: 'a confirmation for this call is already pending' };
    }
    const entry = {
      id: `confirm-${toolName}-${clock()}-${pending.size}`,
      resolve: null,
      created_ms: clock(), expires_ms: clock() + confirmationTtlMs,
      toolName, toolTier: TIERS.STATEFUL_CONTROL, origin, reason,
    };
    pending.set(key, entry);
    audit({ tool: toolName, tier: TIERS.STATEFUL_CONTROL, origin,
            decision: 'confirmation-required', reason,
            confirmation_id: entry.id, expires_ms: entry.expires_ms });
    if (basisHint === BASES.UI_DIRECT_CLICK) {
      // R1.6-D1: the user's own initiating click IS the confirmation —
      // honest basis, no extra dialog, recorded as such.
      resolveConfirmation(entry.id, true, BASES.UI_DIRECT_CLICK);
      return { decision: 'granted', basis: BASES.UI_DIRECT_CLICK,
               confirmation_id: entry.id };
    }
    return { decision: 'confirmation-required', id: entry.id, reason,
             expires_ms: entry.expires_ms };
  }

  function retireExpired(entry, key) {
    pending.delete(key);
    audit({ tool: entry.toolName, tier: entry.toolTier, origin: entry.origin,
            decision: 'confirmation-expired', confirmation_id: entry.id,
            reason: 'ttl elapsed before a human answered' });
    if (entry.resolve) {
      entry.resolve({ expired: true });
    }
  }

  /** The single resolver — confirmation IPC handler only. Late answers
   * on expired entries are refused and the side effect does NOT run
   * (R1-4 red case). */
  function resolveConfirmation(id, approved, basis) {
    const usedBasis = approved
        ? (basis === BASES.UI_DIRECT_CLICK ? BASES.UI_DIRECT_CLICK
                                           : BASES.HUMAN_APPROVED)
        : BASES.HUMAN_DENIED;
    for (const [key, entry] of pending) {
      if (entry.id !== id) {
        continue;
      }
      if (clock() >= entry.expires_ms) {
        retireExpired(entry, key);
        return { ok: false, reason: 'confirmation-expired' };
      }
      pending.delete(key);
      audit({ tool: entry.toolName, tier: entry.toolTier,
              origin: entry.origin,
              decision: approved ? 'confirmed' : 'denied-by-user',
              basis: usedBasis, confirmation_id: id,
              reason: entry.reason });
      if (entry.resolve) {
        entry.resolve({ approved, basis: usedBasis });
      }
      return { ok: true };
    }
    return { ok: false, reason: 'unknown-confirmation' };
  }

  /** Loops/watchdogs retire their own pending requests on cancel or
   * timeout so no late answer can fire a side effect afterwards. */
  function cancelPending(id) {
    for (const [key, entry] of pending) {
      if (entry.id === id) {
        pending.delete(key);
        audit({ tool: entry.toolName, tier: entry.toolTier,
                origin: entry.origin, decision: 'confirmation-cancelled',
                confirmation_id: id });
        if (entry.resolve) {
          entry.resolve({ cancelled: true });
        }
        return true;
      }
    }
    return false;
  }

  function cancelAllPending(origin) {
    const ids = [];
    for (const [, entry] of pending) {
      if (!origin || entry.origin === origin) {
        ids.push(entry.id);
      }
    }
    for (const id of ids) {
      cancelPending(id);
    }
    return ids;
  }

  /** Snapshot of the pending queue for the human confirmation surface. */
  function pendingList() {
    return [...pending.values()].map((e) => ({
      id: e.id, tool: e.toolName, origin: e.origin, reason: e.reason,
      created_ms: e.created_ms, expires_ms: e.expires_ms,
    }));
  }

  /** The single execution entry (Agent, UI and MCP alike). */
  async function execute(tool, args, context) {
    const origin = context && context.origin ? context.origin : 'unknown';
    const reason = context && context.reason;
    const basisHint = context && context.basisHint;
    const g = tool.tier === TIERS.READ_EVIDENCE
        ? gateRead(tool.name, origin)
        : gateStateful(tool.name, origin, reason, basisHint);
    if (g.decision === 'denied') {
      const err = new Error(`broker denied ${tool.name}: ${g.reason}`);
      err.code = 'BROKER_DENIED';
      err.brokerReason = g.reason;
      throw err;
    }
    if (g.decision === 'confirmation-required') {
      const entry = [...pending.values()].find((e) => e.id === g.id);
      if (!entry) {
        const err = new Error(
            `broker: confirmation vanished for ${tool.name}`);
        err.code = 'BROKER_DENIED';
        throw err;
      }
      // m2: expose OUR confirmation id to the caller (watchdogs retire
      // it on timeout; no second gate() needed anywhere).
      if (context && typeof context.onConfirmation === 'function') {
        try {
          context.onConfirmation(entry.id);
        } catch {
          /* observer failures never block execution */
        }
      }
      const answer = await new Promise((resolve) => {
        entry.resolve = resolve;
      });
      if (answer && (answer.expired || answer.cancelled)) {
        const err = new Error(
            `broker: ${tool.name} ${answer.expired ? 'confirmation-expired'
                                                   : 'cancelled'}`);
        err.code = 'BROKER_DENIED';
        err.brokerReason = answer.expired ? 'confirmation-expired'
                                          : 'confirmation-cancelled';
        throw err;
      }
      if (!answer || !answer.approved) {
        const err = new Error(`broker: ${tool.name} denied by user`);
        err.code = 'BROKER_DENIED';
        err.brokerReason = 'denied-by-user';
        throw err;
      }
    }
    const started = clock();
    try {
      const result = await tool.run(args, context);
      audit({ tool: tool.name, tier: tool.tier, origin,
              decision: 'executed', duration_ms: clock() - started });
      return result;
    } catch (error) {
      audit({ tool: tool.name, tier: tool.tier, origin,
              decision: 'execution-failed', error: String(error.message) });
      throw error;
    }
  }

  return {
    TIERS, BASES,
    register,
    gate: (toolName, toolTier, context) => toolTier === TIERS.READ_EVIDENCE
        ? gateRead(toolName, (context && context.origin) || 'unknown')
        : gateStateful(toolName, (context && context.origin) || 'unknown',
                       context && context.reason,
                       context && context.basisHint),
    execute,
    resolveConfirmation,
    cancelPending,
    cancelAllPending,
    pendingList,
    pendingIds: () => [...pending.values()].map((e) => e.id),
    pendingCount: () => pending.size,
    audit,
    ledgerPath,
  };
}

module.exports = { createBroker, TIERS, BASES };
