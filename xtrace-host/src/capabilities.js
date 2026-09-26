'use strict';
// P6-E1: capability negotiation (draft §11.1).
//
// The Host combines the browser's XTrace.getCapabilities with its own
// adapter registry into a THREE-STATE tool list:
//   available  — enhanced browser capability + registered adapter
//   degraded   — usable subset, the gap EXPLICITLY disclosed
//   unavailable— refused with the reason (never silently substituted
//                weaker behavior)
// Frozen P6 rule: connecting to a non-enhanced browser (no XTrace
// domain) => every enhanced tool reports unavailable with that reason.

const TIERS = require('./broker').TIERS;

function negotiate({ browserCapabilities, adapters }) {
  // browserCapabilities: { hasXTraceDomain: bool, domains: [..],
  //                       raw?: {...} } | null  (null => probe failed)
  const enhanced = Boolean(browserCapabilities && browserCapabilities.hasXTraceDomain);
  const list = [];
  for (const adapter of adapters) {
    if (!enhanced) {
      list.push({
        name: adapter.name,
        tier: adapter.tier,
        state: 'unavailable',
        reason: 'browser has no XTrace domain (non-enhanced build)',
      });
      continue;
    }
    const declaredUnavailable =
        (typeof adapter.available === 'function' &&
         !adapter.available(browserCapabilities)) ||
        (typeof adapter.available !== 'function' &&
         typeof adapter.unavailableReason === 'string');
    if (declaredUnavailable) {
      list.push({
        name: adapter.name,
        tier: adapter.tier,
        state: 'unavailable',
        reason: adapter.unavailableReason || 'adapter reports unavailable',
      });
      continue;
    }
    // Available — with an EXPLICITLY disclosed gap when the adapter
    // declares one (usable subset, never a silent substitution).
    list.push({
      name: adapter.name,
      tier: adapter.tier,
      state: adapter.degradedReason ? 'degraded' : 'available',
      reason: adapter.degradedReason || undefined,
      input: adapter.input,
      output: adapter.output,
      scope: adapter.scope,
      sideEffects: adapter.sideEffects || 'none',
      integrity: adapter.integrity || 'read-only',
    });
  }
  return { enhanced, tools: list };
}

/** The E1 adapter registry skeleton: shapes registered; run functions
 * land with the tools themselves in E2/E3. */
function registry() {
  const adapters = [];
  return {
    add(adapter) {
      if (!adapter.name || !Object.values(TIERS).includes(adapter.tier)) {
        throw new Error(`bad adapter registration: ${adapter.name}`);
      }
      adapters.push(adapter);
      return adapter;
    },
    all: () => [...adapters],
    negotiate: (caps) => negotiate({ browserCapabilities: caps, adapters }),
  };
}

module.exports = { negotiate, registry };
