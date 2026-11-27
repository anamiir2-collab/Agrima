/* Agrima local-only access policy.
   No accounts, authentication, roles, remote services, or cloud permissions.
   All features remain available on this device. */
(function (global) {
  'use strict';
  const state = { role: null, userId: null, email: null, fullName: 'مستخدم محلي', active: true };
  const PERM = {
    state,
    ROLES: { ADMIN: 'admin', WAREHOUSE: 'warehouse', LOCAL: 'local', NONE: null },
    isAdmin: () => true,
    isWarehouse: () => false,
    isLocal: () => true,
    signedIn: () => false,
    role: () => 'local',
    roleLabel: () => 'استخدام محلي',
    can: () => true,
    routeAllowed: () => true,
    navVisible: () => true,
    inKeeperWindow: () => true,
    setProfile: () => {},
  };
  global.PERM = PERM;
  /* Compatibility shim for legacy screens: it never creates a network client. */
  global.SB = { client: () => null, humanError: (e) => (e && e.message) || String(e || '') };
  if (typeof module !== 'undefined' && module.exports) module.exports = PERM;
})(window);
