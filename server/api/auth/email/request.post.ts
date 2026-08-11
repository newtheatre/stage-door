import { db, schema } from '@nuxthub/db'
import { eq } from 'drizzle-orm'

/**
 * POST /api/auth/email/request — resend the verification email for the
 * logged-in user. Response is identical whether or not a new link was
 * actually sent (already-verified accounts get the same answer).
 */
export default defineEventHandler(async (event) => {
  const { user: sessionUser } = await requireUserSession(event)

  await enforceRateLimit('verify-request:ip', getClientIP(event))
  await enforceRateLimit('verify-request:acct', sessionUser.id)

  const user = await db.select().from(schema.users).where(eq(schema.users.id, sessionUser.id)).get()

  if (user && !user.verified && !user.disabled) {
    const token = await createEmailVerificationToken(user.id)
    await sendVerificationEmail(user.email, token)
  }

  return { ok: true }
})
