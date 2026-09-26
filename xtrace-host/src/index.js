'use strict';
// P6-E1 public surface.
module.exports = {
  createHost: require('./host').createHost,
  resolveOrphan: require('./host').resolveOrphan,
  createBroker: require('./broker').createBroker,
  TIERS: require('./broker').TIERS,
  createWorkspace: require('./workspace').createWorkspace,
  negotiate: require('./capabilities').negotiate,
  registry: require('./capabilities').registry,
};
