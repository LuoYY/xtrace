'use strict';
// P6-R1 (R1-6): the agent tool-call loop. R1 hardening:
//   * makeSlice errors are REPORTED to the model like tool errors —
//     the loop NEVER unwinds on a slice failure (B4).
//   * Context accounting uses ACTUAL result bytes (M13): tool returns
//     over budget are refused with a pointer to narrower queries, same
//     rule as slices. Raw traces enter neither way.
//   * Watchdog timeout cancels the broker pending confirmation (M4) so
//     a late approval cannot fire a side effect after the loop moved on.

const { createSlicer } = require('./slicer');

const DEFAULT_LIMITS = {
  max_iterations: 24,
  context_bytes: 131072,
  call_timeout_ms: 30000,
  no_progress_streak: 3,
};

function createAgentLoop({ broker, tools, index, workspace, model,
                           limits, host }) {
  const lim = { ...DEFAULT_LIMITS, ...(limits || {}) };
  const slicer = createSlicer({ index, budget: limits?.slice_budget });
  const byName = new Map(tools.map((t) => [t.name, t]));

  /** Tool schema mapping for the model surface (R1-9: negotiated state
   * rides along when the host provides toolSchemas). */
  function toolSchemas() {
    const base = tools.map((t) => ({
      name: t.name,
      tier: t.tier,
      input: t.input || {},
      output: t.output || 'unknown',
      state: t.state || undefined,
      reason: t.reason || t.degradedReason || undefined,
    }));
    if (host && typeof host.toolSchemas === 'function') {
      // the composition root's negotiated surface wins when present
      return host.toolSchemas();   // async at the call site
    }
    return base;
  }

  async function schemasForModel() {
    if (host && typeof host.toolSchemas === 'function') {
      return host.toolSchemas();
    }
    return toolSchemas();
  }

  /** ONE cancellable tool execution. Cancellation honored before
   * dispatch; the watchdog races execution AND retires the broker
   * pending confirmation on timeout (M4). */
  async function runToolCall(call, ctx) {
    if (ctx.cancelled) {
      throw Object.assign(new Error('cancelled'), { code: 'CANCELLED' });
    }
    const tool = byName.get(call.name);
    if (!tool) {
      return { error: `unknown tool: ${call.name}` };
    }
    let timer = null;
    let confirmationId = null;
    const watchdog = new Promise((_, reject) => {
      timer = setTimeout(() => {
        // M4: retire our own pending confirmation so no late approval
        // fires the side effect after we report the timeout.
        if (confirmationId && broker.cancelPending) {
          broker.cancelPending(confirmationId);
        }
        reject(Object.assign(
            new Error(`tool timeout: ${call.name}`),
            { code: 'TOOL_TIMEOUT' }));
      }, lim.call_timeout_ms);
    });
    try {
      const result = await Promise.race([
        broker.execute(tool, call.args || {}, {
          origin: 'agent',
          reason: call.reason || 'agent loop tool call',
          onConfirmation: (id) => { confirmationId = id; },
        }),
        watchdog,
      ]);
      return { result };
    } catch (error) {
      if (error.code === 'CANCELLED') {
        throw error; // only cancellation unwinds the loop
      }
      // denials, timeouts and tool failures are REPORTED (frx guardrail
      // semantics, not weakened); the no-progress breaker decides when
      // to stop.
      return { error: String(error.message) };
    } finally {
      clearTimeout(timer);
    }
  }

  /** The loop: slices (three shapes) + tools, both byte-accounted; the
   * model adapter decides each step. */
  async function run({ cancellation } = {}) {
    const ctx = {
      cancelled: false,
      contextBytes: 0,
      slices: [],
      log: [],
      cancel() {
        this.cancelled = true;
      },
    };
    const external = cancellation || { cancelled: false };
    let noProgress = 0;
    let iteration = 0;
    let last = null;
    while (iteration < lim.max_iterations) {
      if (ctx.cancelled || external.cancelled) {
        return { status: 'cancelled', iterations: iteration, log: ctx.log };
      }
      iteration += 1;
      const decision = await model({
        iteration,
        tools: await schemasForModel(),
        slices: ctx.slices,
        last,
        budget: { used: ctx.contextBytes, max: lim.context_bytes },
      });
      if (decision.type === 'final') {
        ctx.log.push({ iteration, type: 'final' });
        return { status: 'complete', answer: decision.answer,
                 iterations: iteration, log: ctx.log };
      }
      if (decision.type === 'slice') {
        // R1-6/B4: slice failures are REPORTED, never thrown
        let slice;
        try {
          slice = makeSlice(decision.shape, decision.capture_id,
                            decision.options);
        } catch (error) {
          ctx.log.push({ iteration, type: 'slice-error',
                         shape: decision.shape,
                         error: String(error.message) });
          last = { error: `slice failed: ${error.message}` };
          noProgress += 1;
          if (noProgress >= lim.no_progress_streak) {
            return { status: 'no-progress', iterations: iteration,
                     log: ctx.log };
          }
          continue;
        }
        const bytes = JSON.stringify(slice).length;
        if (ctx.contextBytes + bytes > lim.context_bytes) {
          ctx.log.push({ iteration, type: 'slice-rejected',
                         reason: 'context budget exhausted', bytes });
          last = { error: 'context budget exhausted — query narrower slices' };
          noProgress += 1;
        } else {
          ctx.slices.push(slice);
          ctx.contextBytes += bytes;
          ctx.log.push({ iteration, type: 'slice', shape: decision.shape,
                         bytes });
          last = { slice: decision.shape, bytes };
          noProgress = 0;
        }
        continue;
      }
      if (decision.type === 'tool') {
        const outcome = await runToolCall(decision, ctx);
        // M13: account by ACTUAL bytes; over-budget results are refused
        // with a narrower-query pointer (raw traces never ride along).
        const actualBytes = outcome.error
            ? outcome.error.length
            : JSON.stringify(outcome.result || {}).length;
        if (actualBytes > lim.context_bytes) {
          ctx.log.push({ iteration, type: 'tool-result-refused',
                         name: decision.name, bytes: actualBytes });
          last = { error: 'tool result exceeded the context budget — ' +
                          'narrow the query (limit/from_seq)' };
          noProgress += 1;
        } else {
          ctx.contextBytes += Math.min(actualBytes, 8192);
          ctx.log.push({ iteration, type: 'tool', name: decision.name,
                         ok: !outcome.error, bytes: actualBytes });
          last = outcome;
          noProgress = outcome.error ? noProgress + 1 : 0;
        }
        if (noProgress >= lim.no_progress_streak) {
          return { status: 'no-progress', iterations: iteration,
                   log: ctx.log };
        }
        continue;
      }
      throw new Error(`bad model decision: ${decision.type}`);
    }
    return { status: 'max-iterations', iterations: iteration, log: ctx.log };
  }

  function makeSlice(shape, captureId, options) {
    if (shape === 'manifest-summary') {
      return slicer.manifestSummary(captureId);
    }
    if (shape === 'evidence-slice') {
      return slicer.evidenceSlice(captureId, options || {});
    }
    if (shape === 'index-results') {
      return slicer.indexResults(options?.rows || []);
    }
    throw new Error(`unknown slice shape: ${shape}`);
  }

  return { run, toolSchemas: schemasForModel, slicer };
}

module.exports = { createAgentLoop };
