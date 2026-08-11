import { db, schema } from '@nuxthub/db'
import { eq, sql } from 'drizzle-orm'

/**
 * POST /api/account/logout-everywhere — self-service kill switch: bump own
 * session epoch (invalidates every session at next refresh) and clear this
 * one immediately.
 */
export default defineEventHandler(async (event) => {
  const { user } = await requireAccountUser(event)

  await db.update(schema.users)
    .set({ sessionEpoch: sql`${schema.users.sessionEpoch} + 1` })
    .where(eq(schema.users.id, user.id))

  await writeAudit({
    actorUserId: user.id,
    action: 'user.logout-everywhere',
    target: user.id,
  })

  await clearUserSession(event)

  return { ok: true }
})
