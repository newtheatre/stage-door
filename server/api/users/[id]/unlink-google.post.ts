import { db, schema } from '@nuxthub/db'
import { eq } from 'drizzle-orm'

/**
 * Clear the Google link. Refuses if it would leave the account with no login
 * method.
 */
export default defineEventHandler(async (event) => {
  const { user: admin } = await requireAuthAdmin(event)
  const user = await loadUserOr404(getRouterParam(event, 'id'), {
    notSelf: { actorId: admin.id, message: 'Use your own account settings to unlink Google' },
  })

  if (user.googleSub === null) {
    throw createError({ statusCode: 400, statusMessage: 'No Google account is linked' })
  }
  if (user.password === null) {
    throw createError({
      statusCode: 400,
      statusMessage: 'Unlinking would leave no way to log in: send a password reset first',
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
