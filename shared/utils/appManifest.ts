/**
 * What this service declares about its own roles, in the same shape every
 * consumer app uses (ADR-0018). Served at /api/_hooks/auth/manifest.
 */

/** The `apps.name` this service is registered under (ADR-0024). */
export const SELF_APP_NAME = 'stage-door'

export const APP_MANIFEST = {
  contract: 1,
  namespace: 'auth',
  version: '1',

  permissions: [
    { key: 'admin.access', description: 'Reach the identity admin surface' },
    { key: 'user.read.any', description: 'See any account, its roles and its sign-in methods' },
    { key: 'user.manage.any', description: 'Disable, merge, erase or reset any account' },
    { key: 'role.grant.any', description: 'Grant and revoke roles in any namespace' },
    { key: 'app.manage', description: 'Register apps and issue their service tokens' },
    { key: 'audit.read', description: 'Read the audit log' },
  ],

  roles: [
    {
      role: 'ADMIN',
      description: 'Auth service admin (ITM + continuity holder)',
      // Never expires: losing the last holder closes every admin route.
      defaultExpiry: { kind: 'none' },
      permissions: ['admin.access', 'user.read.any', 'user.manage.any', 'role.grant.any', 'app.manage', 'audit.read'],
      // ADR-0019 refuses enforcing on an :ADMIN role anyway.
      requiresEligibility: null,
    },
  ],

  eligibilityRules: [],
} as const

export type AppManifest = typeof APP_MANIFEST
