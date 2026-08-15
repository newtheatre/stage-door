import { db, schema } from '@nuxthub/db'
import { eq } from 'drizzle-orm'

/**
 * Resend the verification email. The response is identical whether or not a
 * link was actually sent.
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
