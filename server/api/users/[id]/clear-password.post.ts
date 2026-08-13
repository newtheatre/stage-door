import { db, schema } from '@nuxthub/db'
import { eq, sql } from 'drizzle-orm'

/**
 * POST /api/users/:id/clear-password — remove an account's password so it
 * can only sign in with Google (admin) [AUD].
 *
 * The domain rule (ADR-0012) blocks password login for Workspace addresses
 * in code; this enforces it in the data too, for accounts migrated onto
 * SSO. Refuses if it would leave no way in — a Workspace account that has
 * never linked Google still needs its password until it does.
 */
export default defineEventHandler(async (event) => {
  const { user: admin } = await requireAuthAdmin(event)
  const user = await loadUserOr404(getRouterParam(event, 'id'))

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
