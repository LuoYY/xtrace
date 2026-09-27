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
    hostExecPolicy: null,   // null = the whole tier default-denied
    ...(policy || {}),
  };

  const ledgerPath = path.join(workspace.dir('ledger'),
                               `broker-${clock()}.jsonl`);
  // entryKey `${tool}|${origin}|${reason}` -> entry
  const pending = new Map();
  // confirmationId -> { kill, toolName, origin } for RUNNING host-exec
  // children (cancelExecution fires the kill handle)
  const activeExecutions = new Map();

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
      // M3-E1 (PD1): registration is DISCLOSURE, not permission —
      // tools explicitly built to disclose a default-deny (e.g.
      // npm_install) register WITHOUT a policy; general host-exec
      // executors still require one so they cannot silently appear.
      const discloseOnly = tool.discloseOnly === true;
      if (!discloseOnly && !effectivePolicy.hostExecPolicy) {
        throw new Error(
            `tool ${tool.name}: host-exec tier requires a policy object ` +
            `(default-deny without one)`);
      }
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
  /** M3-E1 (PD1): the host-exec gate. Default-deny without a policy;
   * with one, EVERY action must carry a concrete payload (argv or path
   * or domain) which is policy-evaluated (hit/miss recorded), shown in
   * the confirmation, and audited in full. Wildcards like '*' in
   * network.allow trip the too-wide guard (never silently accepted). */
  function gateHostExec(toolName, origin, reason, action) {
    const pol = effectivePolicy.hostExecPolicy;
    if (!pol) {
      audit({ tool: toolName, tier: TIERS.HOST_EXEC, origin,
              decision: 'denied',
              policy_verdict: 'no-policy:tier-default-deny' });
      return { decision: 'denied',
               reason: 'host-exec tier disabled (no policy object)' };
    }
    if (typeof reason !== 'string' || reason.trim().length < 3) {
      audit({ tool: toolName, tier: TIERS.HOST_EXEC, origin,
              decision: 'denied', reason: 'missing-reason-string' });
      return { decision: 'denied',
               reason: 'host-exec requires a reason string' };
    }
    // too-wide guard: '*' entries defeat the policy's purpose
    const net = (pol.network && pol.network.allow) || [];
    if (net.includes('*')) {
      audit({ tool: toolName, tier: TIERS.HOST_EXEC, origin,
              decision: 'denied',
              policy_verdict: 'policy-too-wide:network.allow contains *' });
      return { decision: 'denied',
               reason: 'policy too wide: network.allow must not contain *' };
    }
    if (!(action && typeof action === 'object')) {
      audit({ tool: toolName, tier: TIERS.HOST_EXEC, origin,
              decision: 'denied', reason: 'missing-action-payload' });
      return { decision: 'denied',
               reason: 'host-exec requires a concrete action payload ' +
                       '(argv / path / domain)' };
    }
    // policy evaluation: argv entries outside paths.write, or domains
    // outside network.allow, deny with the exact hit recorded
    const verdicts = [];
    const writeRoots = (pol.paths && pol.paths.write) || [];
    const argv = action.argv || [];
    for (const arg of argv) {
      // A network reference is an explicit http(s) URL — plain argv
      // tokens (flags like -e, script text, numbers) are NEVER domains.
      if (/^https?:\/\//i.test(arg)) {
        const host = arg.replace(/^https?:\/\//i, '').split(/[/:?#]/)[0];
        if (host && !net.includes(host)) {
          verdicts.push(`network-miss:${host}`);
        }
      }
    }
    if (action.writePath) {
      // R1-5: resolve BOTH sides before comparing — the unresolved
      // prefix let policy say "allowed" while the workspace's realpath
      // gate refused the actual write (audit/write disagreement).
      const resolvedWrite = fs.existsSync(action.writePath)
          ? path.resolve(fs.realpathSync(action.writePath))
          : path.resolve(action.writePath);
      const inside = writeRoots.some((root) => {
        const resolvedRoot = fs.existsSync(root)
            ? fs.realpathSync(root) : path.resolve(root);
        return resolvedWrite === resolvedRoot ||
            resolvedWrite.startsWith(resolvedRoot.replace(/\/$/, '') + '/');
      });
      if (!inside) {
        verdicts.push(`write-outside-policy:${action.writePath}`);
      }
    }
    if (verdicts.length) {
      audit({ tool: toolName, tier: TIERS.HOST_EXEC, origin,
              decision: 'denied', policy_verdict: verdicts.join(';'),
              argv: argv.join(' ') || action.writePath || '' });
      return { decision: 'denied',
               reason: `policy denied: ${verdicts.join(';')}` };
    }
    // allowed by policy — still needs the per-call human confirmation
    // with the CONCRETE payload disclosed
    const key = entryKey(toolName, origin, reason);
    const existing = pending.get(key);
    if (existing) {
      if (clock() >= existing.expires_ms) {
        retireExpired(existing, key);
      } else {
        audit({ tool: toolName, tier: TIERS.HOST_EXEC, origin,
                decision: 'denied',
                reason: 'duplicate-confirmation-pending',
                confirmation_id: existing.id });
        return { decision: 'denied',
                 reason: 'a confirmation for this action is already pending' };
      }
    }
    const entry = {
      id: `confirm-${toolName}-${clock()}-${pending.size}`,
      resolve: null,
      created_ms: clock(), expires_ms: clock() + confirmationTtlMs,
      toolName, toolTier: TIERS.HOST_EXEC, origin, reason,
      action,   // the pending queue surface renders this payload
    };
    pending.set(key, entry);
    entry.expiryTimer = setTimeout(() => {
      if (pending.get(key) === entry) {
        retireExpired(entry, key);
      }
    }, Math.max(1, entry.expires_ms - clock()));
    audit({ tool: toolName, tier: TIERS.HOST_EXEC, origin,
            decision: 'confirmation-required', reason,
            confirmation_id: entry.id, expires_ms: entry.expires_ms,
            policy_verdict: 'allowed',
            argv: argv.join(' ') || action.writePath || '' });
    return { decision: 'confirmation-required', id: entry.id, reason,
             action, expires_ms: entry.expires_ms };
  }

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
    // The TTL is LIVE: an expiry timer retires the entry at expires_ms
    // (a parked waiter with no timer settles never and drains the loop).
    // (The timer is NOT unref'd: a CLI process parked on a pending
    // confirmation must stay alive until the TTL settles it — unref let
    // node exit silently with the waiter hanging forever.)
    entry.expiryTimer = setTimeout(() => {
      if (pending.get(key) === entry) {
        retireExpired(entry, key);
      }
    }, Math.max(1, entry.expires_ms - clock()));
    audit({ tool: toolName, tier: TIERS.STATEFUL_CONTROL, origin,
            decision: 'confirmation-required', reason,
            confirmation_id: entry.id, expires_ms: entry.expires_ms });
    // R2-6 (D1 hole): ONLY a UI-origin direct click may self-confirm —
    // an agent/mcp caller passing basisHint parks at pending like any
    // other unconfirmed stateful call.
    if (basisHint === BASES.UI_DIRECT_CLICK && origin === 'ui') {
      resolveConfirmation(entry.id, true, BASES.UI_DIRECT_CLICK);
      return { decision: 'granted', basis: BASES.UI_DIRECT_CLICK,
               confirmation_id: entry.id };
    }
    return { decision: 'confirmation-required', id: entry.id, reason,
             expires_ms: entry.expires_ms };
  }

  function retireExpired(entry, key) {
    pending.delete(key);
    if (entry.expiryTimer) {
      clearTimeout(entry.expiryTimer);
    }
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
      if (entry.expiryTimer) {
        clearTimeout(entry.expiryTimer);
      }
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
        if (entry.expiryTimer) {
          clearTimeout(entry.expiryTimer);
        }
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

  /** M3-E1: cancel a RUNNING host-exec child — the kill handle the
   * executor registered fires, the child dies, the audit records it. */
  function cancelExecution(id) {
    const record = activeExecutions.get(id);
    if (!record) {
      return false;
    }
    activeExecutions.delete(id);
    if (record.kill) {
      record.kill();
    }
    audit({ tool: record.toolName, tier: TIERS.HOST_EXEC,
            origin: record.origin, decision: 'execution-cancelled',
            confirmation_id: id });
    return true;
  }

  /** Snapshot of the pending queue for the human confirmation surface
   * — INCLUDING the concrete action payload (PD1: the confirmation
   * shows argv / writePath, not just the tool name). */
  function pendingList() {
    return [...pending.values()].map((e) => ({
      id: e.id, tool: e.toolName, origin: e.origin, reason: e.reason,
      created_ms: e.created_ms, expires_ms: e.expires_ms,
      action: e.action || null,
    }));
  }

  /** M3-R1-5: RUNNING host-exec executions with their kill handles —
   * the product surface for cancelExecution routing. */
  function runningExecutions() {
    return [...activeExecutions.entries()].map(([id, record]) => ({
      id, tool: record.toolName, origin: record.origin,
      kill_registered: Boolean(record.kill),
    }));
  }

  /** The single execution entry (Agent, UI and MCP alike). */
  async function execute(tool, args, context) {
    const origin = context && context.origin ? context.origin : 'unknown';
    const reason = context && context.reason;
    const basisHint = context && context.basisHint;
    const g = tool.tier === TIERS.READ_EVIDENCE
        ? gateRead(tool.name, origin)
        : tool.tier === TIERS.HOST_EXEC
            ? gateHostExec(tool.name, origin, reason,
                           args && args.__action)
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
      // M3-E1: host-exec executions register a kill handle so
      // cancelExecution() can terminate the RUNNING child. The broker
      // INJECTS the registration callback (the caller never has to
      // provide one); the entry is inert until the child spawns.
      if (tool.tier === TIERS.HOST_EXEC) {
        const record = { toolName: tool.name, origin, kill: null };
        activeExecutions.set(entry.id, record);
        const ctxRef = context || (args.__context = {});
        ctxRef.onKill = (fn) => { record.kill = fn; };
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
      if (tool.tier === TIERS.HOST_EXEC && context &&
          typeof context.onConfirmation === 'function') {
        // best-effort registry cleanup (the id is opaque here)
        for (const [id, record] of activeExecutions) {
          if (record.toolName === tool.name && record.origin === origin) {
            activeExecutions.delete(id);
          }
        }
      }
      const extra = tool.tier === TIERS.HOST_EXEC ? {
        argv: (args && args.__action && args.__action.argv || [])
            .join(' '),
        exit_code: result && result.exit_code,
        output_bytes: result && result.output_bytes,
        timed_out: Boolean(result && result.timed_out),
        cancelled: Boolean(result && result.cancelled),
      } : {};
      audit({ tool: tool.name, tier: tool.tier, origin,
              decision: 'executed', duration_ms: clock() - started,
              ...extra });
      return result;
    } catch (error) {
      audit({ tool: tool.name, tier: tool.tier, origin,
              decision: 'execution-failed',
              error: String(error.message),
              ...(tool.tier === TIERS.HOST_EXEC ? {
                argv: (args && args.__action && args.__action.argv || [])
                    .join(' ') } : {}) });
      throw error;
    }
  }

  return {
    TIERS, BASES,
    register,
    gate: (toolName, toolTier, context) => {
      const origin = (context && context.origin) || 'unknown';
      if (toolTier === TIERS.READ_EVIDENCE) {
        return gateRead(toolName, origin);
      }
      if (toolTier === TIERS.HOST_EXEC) {
        return gateHostExec(toolName, origin, context && context.reason,
                            context && context.action);
      }
      return gateStateful(toolName, origin, context && context.reason,
                          context && context.basisHint);
    },
    execute,
    resolveConfirmation,
    cancelPending,
    cancelExecution,
    cancelAllPending,
    pendingList,
    runningExecutions,
    pendingIds: () => [...pending.values()].map((e) => e.id),
    pendingCount: () => pending.size,
    audit,
    ledgerPath,
  };
}

module.exports = { createBroker, TIERS, BASES };
