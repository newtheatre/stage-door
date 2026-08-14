import { db, schema } from '@nuxthub/db'
import { eq, sql } from 'drizzle-orm'

/**
 * Bump the session epoch. Existing sessions die at their next refresh or
 * privileged action.
 */
export default defineEventHandler(async (event) => {
  const { user: admin } = await requireAuthAdmin(event)
  const user = await loadUserOr404(getRouterParam(event, 'id'))

  await db.update(schema.users)
    .set({ sessionEpoch: sql`${schema.users.sessionEpoch} + 1` })
    .where(eq(schema.users.id, user.id))

  await writeAudit({
    actorUserId: admin.id,
    action: 'user.force-logout',
    target: user.id,
  })

  return { ok: true }
})
