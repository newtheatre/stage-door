import { db, schema } from '@nuxthub/db'
import { eq, sql } from 'drizzle-orm'

/**
 * Remove an account's password so it can only sign in with Google.
 * Refuses if it would leave no way in.
 */
export default defineEventHandler(async (event) => {
  const { user: admin } = await requireAuthAdmin(event)
  const user = await loadUserOr404(getRouterParam(event, 'id'), {
    notSelf: { actorId: admin.id, message: 'Use your own account settings to change your password' },
  })

  if (user.password === null) {
    throw createError({ statusCode: 400, statusMessage: 'This account has no password' })
  }
  if (user.googleSub === null) {
    throw createError({
      statusCode: 400,
      statusMessage: 'Link a Google account first — clearing the password now would lock this account out',
    })
  }

  await db.update(schema.users)
    .set({ password: null, sessionEpoch: sql`${schema.users.sessionEpoch} + 1` })
    .where(eq(schema.users.id, user.id))

  await writeAudit({
    actorUserId: admin.id,
    action: 'user.password-cleared',
    target: user.id,
    detail: { reason: 'moved to Google SSO' },
  })

  return { ok: true }
})
