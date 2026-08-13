import { db, schema } from '@nuxthub/db'
import { eq } from 'drizzle-orm'

/** GET /api/users/:id — full admin profile incl. roles and legacy ids. */
export default defineEventHandler(async (event) => {
  await requireAuthAdmin(event)
  const user = await loadUserOr404(getRouterParam(event, 'id'))

  const grants = await loadRoleGrants(user.id)
  const legacyIds = await db.select({
    source: schema.legacyIds.source,
    legacyId: schema.legacyIds.legacyId,
  }).from(schema.legacyIds).where(eq(schema.legacyIds.userId, user.id)).all()

  // Second-factor state (ADR-0012) — what is enrolled, never a secret.
  const mfa = {
    required: await isMfaRequired(user),
    factors: await enrolledFactors(user.id),
    passkeys: (await listPasskeys(user.id)).length,
    recoveryCodesRemaining: await remainingRecoveryCodes(user.id),
  }

  return { user: { ...adminUserView(user, grants), legacyIds, mfa } }
})
