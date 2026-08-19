import { db, schema } from '@nuxthub/db'
import { eq, sql } from 'drizzle-orm'

/**
 * Clear every second factor — the "lost their phone" path. Verify identity
 * out of band first; this removes the protection until they re-enrol.
 */
export default defineEventHandler(async (event) => {
  const { user: admin } = await requireAuthAdmin(event)
  const user = await loadUserOr404(getRouterParam(event, 'id'), {
    notSelf: { actorId: admin.id, message: 'Use your own account settings to manage your second factors' },
  })

  await clearAllFactors(user.id)

  // Without this the thief's session outlives the factors it was sealed
  // behind, which is the case this endpoint exists for.
  await db.update(schema.users)
    .set({ sessionEpoch: sql`${schema.users.sessionEpoch} + 1` })
    .where(eq(schema.users.id, user.id))

  await writeAudit({
    actorUserId: admin.id,
    action: 'mfa.admin-reset',
    target: user.id,
  })

  return { ok: true }
})
