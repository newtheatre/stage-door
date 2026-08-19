import { db, schema } from '@nuxthub/db'
import { eq } from 'drizzle-orm'

/** GET /api/users/:id: full admin profile incl. roles and legacy ids. */
export default defineEventHandler(async (event) => {
  await requireAuthAdmin(event)
  const user = await loadUserOr404(getRouterParam(event, 'id'))

  // All independent of each other, and this backs one page view.
  const [grants, legacyIds, factors, passkeys, recoveryCodesRemaining] = await Promise.all([
    loadRoleGrants(user.id),
    db.select({
      source: schema.legacyIds.source,
      legacyId: schema.legacyIds.legacyId,
    }).from(schema.legacyIds).where(eq(schema.legacyIds.userId, user.id)).all(),
    enrolledFactors(user.id),
    listPasskeys(user.id),
    remainingRecoveryCodes(user.id),
  ])

  // The grants are already loaded, so isMfaRequired takes the effective set
  // rather than re-running the eligibility query to find it.
  const effective = grants.filter(g => !g.expired && !g.inert).map(g => g.role)

  // Second-factor state (ADR-0012): what is enrolled, never a secret.
  const mfa = {
    required: await isMfaRequired(user, effective),
    factors,
    passkeys: passkeys.length,
    recoveryCodesRemaining,
  }

  return { user: { ...adminUserView(user, grants), legacyIds, mfa } }
})
