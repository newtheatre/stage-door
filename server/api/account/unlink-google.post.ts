import { db, schema } from '@nuxthub/db'
import { eq } from 'drizzle-orm'

/**
 * POST /api/account/unlink-google: self-service disconnect. Refuses if the
 * account would be left with no login method.
 */
export default defineEventHandler(async (event) => {
  const { user, loggedInAt } = await requireAccountUser(event)

  if (user.googleSub === null) {
    throw createError({ statusCode: 400, statusMessage: 'No Google account is linked' })
  }
  if (user.password === null) {
    throw createError({
      statusCode: 400,
      statusMessage: 'Set a password first: unlinking now would lock you out',
    })
  }

  const [updated] = await db.update(schema.users)
    .set({ googleSub: null })
    .where(eq(schema.users.id, user.id))
    .returning()

  await writeAudit({
    actorUserId: user.id,
    action: 'google.unlinked',
    target: user.id,
    detail: { via: 'self-service' },
  })

  const roles = await loadRoles(user.id)
  await sealUserSession(event, updated!, roles, { fresh: false, loggedInAt })

  return { ok: true }
})
