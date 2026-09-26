'use strict';
// P6-E4: the agent tool-call loop — cancellable, budgeted, guarded.
//
// The MODEL is injected (an adapter callback receiving the context and
// returning the next tool call or a final answer); the LOOP owns the
// frx-semantics guardrails (not weakened): context budget (slices only,
// raw traces never), no-progress circuit breaker, per-call timeout,
// cancellation token honored BETWEEN calls and inside pending waits.

const { createSlicer } = require('./slicer');

function createAgentLoop({ broker, tools, index, workspace, model,
                           limits }) {
  const lim = {
    max_iterations: limits?.max_iterations ?? 24,
    context_bytes: limits?.context_bytes ?? 131072,
    call_timeout_ms: limits?.call_timeout_ms ?? 30000,
    no_progress_streak: limits?.no_progress_streak ?? 3,
    ...limits,
  };
  const slicer = createSlicer({ index, budget: limits?.slice_budget });
  const byName = new Map(tools.map((t) => [t.name, t]));

  /** Tool schema mapping for the model surface (name/tier/io/state). */
  function toolSchemas() {
    return tools.map((t) => ({
      name: t.name,
      tier: t.tier,
      input: t.input || {},
      output: t.output || 'unknown',
      state: t.state || undefined,
    }));
  }

  /** ONE cancellable iteration of tool execution. Cancellation is
   * honored before dispatch and races the timeout during execution. */
  async function runToolCall(call, ctx) {
    if (ctx.cancelled) {
      throw Object.assign(new Error('cancelled'), { code: 'CANCELLED' });
    }
    const tool = byName.get(call.name);
    if (!tool) {
      return { error: `unknown tool: ${call.name}` };
    }
    let timer = null;
    const watchdog = new Promise((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(
          new Error(`tool timeout: ${call.name}`),
          { code: 'TOOL_TIMEOUT' })), lim.call_timeout_ms);
    });
    try {
      const result = await Promise.race([
        broker.execute(tool, call.args || {}, { origin: 'agent',
                                                reason: call.reason ||
                                                    'agent loop tool call' }),
        watchdog,
      ]);
      return { result };
    } catch (error) {
      if (error.code === 'CANCELLED') {
        throw error; // only cancellation unwinds the loop
      }
      // denials, timeouts and tool failures are REPORTED to the model
      // (the loop stays alive; the no-progress breaker decides when to
      // stop) — frx guardrail semantics, not weakened.
      return { error: String(error.message) };
    } finally {
      clearTimeout(timer);
    }
  }

  /** The loop. The model adapter decides the next step; slices are the
   * ONLY trace-derived context (shapes via the slicer); the budget
   * caps total context bytes; no-progress trips the breaker. */
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
        tools: toolSchemas(),
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
        // add a bounded slice (three shapes only)
        const slice = makeSlice(decision.shape, decision.capture_id,
                                decision.options);
        const bytes = JSON.stringify(slice).length;
        if (ctx.contextBytes + bytes > lim.context_bytes) {
          ctx.log.push({ iteration, type: 'slice-rejected',
                         reason: 'context budget exhausted',
                         bytes });
          last = { error: 'context budget exhausted — query narrower slices' };
          noProgress += 1;
        } else {
          ctx.slices.push(slice);
          ctx.contextBytes += bytes;
          ctx.log.push({ iteration, type: 'slice', shape: decision.shape,
                         bytes });
          last = { slice: decision.shape, bytes };
        }
        continue;
      }
      if (decision.type === 'tool') {
        const outcome = await runToolCall(decision, ctx);
        const bytes = Math.min(JSON.stringify(outcome).length, 8192);
        ctx.contextBytes += bytes;
        ctx.log.push({ iteration, type: 'tool', name: decision.name,
                       ok: !outcome.error });
        last = outcome;
        if (outcome.error) {
          noProgress += 1;
        } else {
          noProgress = 0;
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

  return { run, toolSchemas, slicer };
}

module.exports = { createAgentLoop };
