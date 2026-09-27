'use strict';
// M3-R1 (B4): the seven inventory env/fingerprint-family tools,
// disclosed unavailable with their M5 attribution (the "silent
// absence != disclosed unavailability" class — third recurrence).
// env_current is the one M3-scope member: implement it as the
// read-only current-instance/environment query (the instance rows the
// env manager already owns); the fingerprint six stay
// unavailable-with-reason.

const { TIERS } = require('./broker');

function createEnvFamilyAdapters({ envs }) {
  const refuse = (why) => async () => {
    throw new Error('unavailable: ' + why);
  };
  const a = [];

  // M3 env face: current environment + instance rows (READ — the
  // inventory column is 否; instance state is env-manager-owned fact).
  a.push({
    name: 'env_current', tier: TIERS.READ_EVIDENCE,
    input: {},
    output: 'the currently open env + its instance rows',
    run: async () => ({
      open_env: envs.openName(),
      profile: envs.activeProfile(),
      instances: envs.allInstances(),
    }),
  });

  const M5_REASON = 'fingerprint-layer family (M5): no consumer until ' +
      'the fingerprint mount lands — see docs/open-items-register.md M5-2';
  const rows = [
    ['env_read_config', TIERS.READ_EVIDENCE,
     'mount-point JSON storage only; content changes no browser ' +
     'behavior until P7 — M5 attribution, refused in M3'],
    ['env_write_config', TIERS.READ_EVIDENCE,
     M5_REASON + '; writes would be silently ineffective'],
    ['env_generate_fingerprint', TIERS.STATEFUL_CONTROL,
     'generator logic is portable but the Chromium fingerprint ' +
     'baseline needs the M5 layer (and there is no consumer yet)'],
    ['env_capture_fingerprint', TIERS.READ_EVIDENCE,
     'read-only page-JS capture is possible, but the field face ' +
     'needs the M5 Chromium schema — refused rather than mislabeled'],
    ['env_import_fingerprint', TIERS.READ_EVIDENCE,
     'Firefox fingerprint schema does not apply; the Chromium ' +
     'schema is M5 work'],
    ['env_import', TIERS.STATEFUL_CONTROL,
     'environment-directory import {env,fingerprint,proxy} — the ' +
     'fingerprint arm needs M5; refused rather than partial import'],
  ];
  for (const [name, tier, why] of rows) {
    a.push({
      name, tier,
      unavailableReason: why,
      input: {},
      available: () => false,
      run: refuse(why),
    });
  }
  return a;
}

module.exports = { createEnvFamilyAdapters };
