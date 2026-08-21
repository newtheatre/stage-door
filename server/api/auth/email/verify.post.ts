import { db, schema } from '@nuxthub/db'
import { eq } from 'drizzle-orm'
import { z } from 'zod'

const bodySchema = z.object({
  token: z.string().min(1, 'Verification token is required'),
})

/**
 * Verify an email address with a token. Single-use; an expired token triggers
 * an automatic resend.
 */
export default defineEventHandler(async (event) => {
  const { token } = await readValidatedBody(event, bodySchema.parse)

  const verification = await db.select()
    .from(schema.emailVerifications)
    .where(eq(schema.emailVerifications.token, hashLoginToken(token)))
    .get()

  if (!verification) {
    throw createError({
      statusCode: 400,
      statusMessage: 'Invalid or expired verification token',
    })
  }

  if (verification.expiresAt.getTime() < Date.now()) {
    await db.delete(schema.emailVerifications).where(eq(schema.emailVerifications.id, verification.id))

    const user = await db.select().from(schema.users).where(eq(schema.users.id, verification.userId)).get()
    if (user && !user.verified && !user.disabled) {
      const newToken = await createEmailVerificationToken(user.id)
      await sendVerificationEmail(user.email, newToken)
    }

    throw createError({
      statusCode: 400,
      statusMessage: 'Verification token has expired. A new one has been sent to your email.',
    })
  }

  const user = await loadUserOr404(verification.userId)

  const [verified] = user.verified
    ? [user]
    : await db.update(schema.users)
        .set({ verified: true })
        .where(eq(schema.users.id, user.id))
        .returning()

  await db.delete(schema.emailVerifications).where(eq(schema.emailVerifications.id, verification.id))

  // Re-seal the caller's session with the fresh flag (single-writer rule:
  // this service is the only place that may do this).
  const session = await getUserSession(event)

  // An id match alone re-stamps the current epoch onto a cookie force-logout
  // revoked, undoing it. Same liveness check as requireLiveUser.
  if (session.user?.id === user.id && !livenessFailure(session, user)) {
    await reSealSession(event, verified!, session.loggedInAt)
  }

  return { ok: true }
})
