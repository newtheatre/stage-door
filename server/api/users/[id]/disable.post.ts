import { db, schema } from '@nuxthub/db'
import { eq, sql } from 'drizzle-orm'

/**
 * POST /api/users/:id/disable — block login and refresh (reversible;
 * erasure is not — docs/operations.md#user-operations). Also bumps the
 * epoch so live sessions die at next refresh rather than riding out the
 * staleness window on unprivileged pages.
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
