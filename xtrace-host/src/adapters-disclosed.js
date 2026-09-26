'use strict';
// M3-E7: disclosed-unavailable adapters for the OUT-of-scope tools —
// signer_trace/closure_read (M4 observation expansion), whitebox_diff
// (M4/M5 aligner), npm_install (policy-gated default deny, PD1). Each
// carries its reason; runtime ALWAYS refuses. run_node/run_python are
// registered only when a hostExecPolicy exists (executors.js).

const { TIERS } = require('./broker');

function createDisclosedUnavailableAdapters() {
  const refuse = (why) => async () => {
    throw new Error('unavailable: ' + why);
  };
  return [
    { name: 'signer_trace', tier: TIERS.READ_EVIDENCE,
      input: {},
      unavailableReason: 'needs the P4 observer extended to selected-' +
          'script function-entry + arguments observation (CDP ' +
          'breakpoints pause the page — not equivalent); M4 work',
      available: () => false,
      run: refuse('M4 observation expansion pending') },
    { name: 'closure_read', tier: TIERS.READ_EVIDENCE,
      input: {},
      unavailableReason: 'needs value observation extended to ' +
          'post-execution truth + deep serialization (bounded asset ' +
          'contract); M4 work',
      available: () => false,
      run: refuse('M4 observation expansion pending') },
    { name: 'whitebox_diff', tier: TIERS.READ_EVIDENCE,
      input: {},
      unavailableReason: 'V8 coverage is block/function-level vs ' +
          'SpiderMonkey granularity — needs a coverage aligner design ' +
          '(M4/M5)',
      available: () => false,
      run: refuse('coverage aligner design pending (M4/M5)') },
    { name: 'npm_install', tier: TIERS.HOST_EXEC,
      discloseOnly: true,   // registration = disclosure; the gate stays
                            // default-deny (available false + refuse)
      input: { packages: 'string[]' },
      unavailableReason: 'policy-gated default deny: only honored when ' +
          'deps.npm in the hostExecPolicy explicitly allows the ' +
          'package AND network.allow covers the registry host; no ' +
          'wildcards (PD1)',
      available: () => false,
      run: refuse('npm_install requires an explicit deps.npm policy ' +
          'entry — default deny') },
  ];
}

module.exports = { createDisclosedUnavailableAdapters };
