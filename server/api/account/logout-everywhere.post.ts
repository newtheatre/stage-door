import { db, schema } from '@nuxthub/db'
import { eq, sql } from 'drizzle-orm'

/**
 * Self-service kill switch: bump own session epoch, then clear this session.
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
