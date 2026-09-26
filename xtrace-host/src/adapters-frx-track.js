'use strict';
// M3-E5 adapters: the frx track under `not-transferred`. The five
// tools register as unavailable-with-reason (the judgment lives in
// docs/frx-transfer-checklist.md); there is NO self-made substitute —
// the run function ALWAYS refuses. MPL-2.0 sources must arrive via the
// §7 protocol before any of these gain implementations.

const { TIERS } = require('./broker');

const FRX_REASON = 'frx sources not transferred (MPL-2.0); see ' +
    'docs/frx-transfer-checklist.md — no substitute may stand in';

function createFrxTrackAdapters() {
  const refuse = async () => {
    throw new Error('not migrated: ' + FRX_REASON);
  };
  return [
    { name: 'notes_add', tier: TIERS.READ_EVIDENCE,
      input: { note: 'string' }, unavailableReason: FRX_REASON,
      available: () => false, run: refuse },
    { name: 'remember', tier: TIERS.READ_EVIDENCE,
      input: { kind: 'string', text: 'string' },
      unavailableReason: FRX_REASON,
      available: () => false, run: refuse },
    { name: 'wasm_probe', tier: TIERS.READ_EVIDENCE,
      input: { bytes: 'string' }, unavailableReason: FRX_REASON,
      available: () => false, run: refuse },
    { name: 'wasm_disasm', tier: TIERS.READ_EVIDENCE,
      input: { bytes: 'string' }, unavailableReason: FRX_REASON,
      available: () => false, run: refuse },
    { name: 'js_trace', tier: TIERS.READ_EVIDENCE,
      input: { source: 'string' }, unavailableReason: FRX_REASON,
      available: () => false, run: refuse },
  ];
}

module.exports = { createFrxTrackAdapters, FRX_REASON };
