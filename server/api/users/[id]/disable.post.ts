import { db, schema } from '@nuxthub/db'
import { eq, sql } from 'drizzle-orm'

/**
 * Block login and refresh; reversible, unlike erasure. Bumps the epoch so
 * live sessions die at their next refresh.
 */
export default defineEventHandler(async (event) => {
  const { user: admin } = await requireAuthAdmin(event)
  const user = await loadUserOr404(getRouterParam(event, 'id'))

  if (user.id === admin.id) {
    throw createError({ statusCode: 400, statusMessage: 'You cannot disable your own account' })
  }

  await db.update(schema.users)
    .set({ disabled: true, sessionEpoch: sql`${schema.users.sessionEpoch} + 1` })
    .where(eq(schema.users.id, user.id))

  await writeAudit({
    actorUserId: admin.id,
    action: 'user.disabled',
    target: user.id,
  })

  return { ok: true }
})
