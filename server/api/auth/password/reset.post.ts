import { db, schema } from '@nuxthub/db'
import { eq, sql } from 'drizzle-orm'
import { z } from 'zod/v4'

const bodySchema = z.object({
  token: z.string().min(1, 'Reset token is required'),
  password: passwordSchema,
})

/**
 * Set a new password with a reset token. Consumes it, bumps the epoch, then
 * applies the same MFA seam as login. Full contract: docs/api-reference.md
 */
export default defineEventHandler(async (event) => {
  const { token, password } = await readValidatedBody(event, bodySchema.parse)

  await enforceRateLimit('reset:ip', getClientIP(event))

  const resetRecord = await db.select()
    .from(schema.passwordResets)
    .where(eq(schema.passwordResets.token, hashLoginToken(token)))
    .get()

  if (!resetRecord) {
    throw createError({
      statusCode: 400,
      statusMessage: 'Invalid or expired password reset token',
    })
  }

  if (resetRecord.expiresAt.getTime() < Date.now()) {
    await db.delete(schema.passwordResets).where(eq(schema.passwordResets.id, resetRecord.id))

    throw createError({
      statusCode: 400,
      statusMessage: 'Password reset token has expired. Please request a new one.',
    })
  }

  const owner = await db.select({ email: schema.users.email }).from(schema.users)
    .where(eq(schema.users.id, resetRecord.userId)).get()
  assertPasswordAllowed(owner?.email ?? '')

  const hashedPassword = await hashPassword(password)

  const [user] = await db.update(schema.users)
    .set({
      password: hashedPassword,
      sessionEpoch: sql`${schema.users.sessionEpoch} + 1`,
    })
    .where(eq(schema.users.id, resetRecord.userId))
    .returning()

  await db.delete(schema.passwordResets).where(eq(schema.passwordResets.userId, resetRecord.userId))

  if (!user || user.disabled) {
    // Disabled accounts may complete the form but never get a session.
    throw createError({
      statusCode: 400,
      statusMessage: 'Invalid or expired password reset token',
    })
  }

  // A reset must not bypass a second factor (ADR-0013).
  const challenge = await sealOrChallenge(event, user)
  if (challenge) return challenge

  return { ok: true }
})
