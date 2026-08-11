import { db, schema } from '@nuxthub/db'
import { eq } from 'drizzle-orm'

/**
 * POST /api/users/:id/unlink-google — clear the Google link (admin; the
 * leaver process). Refuses if it would leave the account with no login
 * method at all.
 */
export default defineEventHandler(async (event) => {
  const { user: admin } = await requireAuthAdmin(event)
  const user = await loadUserOr404(getRouterParam(event, 'id'))

  if (user.googleSub === null) {
    throw createError({ statusCode: 400, statusMessage: 'No Google account is linked' })
  }
  if (user.password === null) {
    throw createError({
      statusCode: 400,
      statusMessage: 'Unlinking would leave no way to log in — send a password reset first',
    })
  }

  await db.update(schema.users)
    .set({ googleSub: null })
    .where(eq(schema.users.id, user.id))

  await writeAudit({
    actorUserId: admin.id,
    action: 'google.unlinked',
    target: user.id,
    detail: { via: 'admin' },
  })

  return { ok: true }
})
