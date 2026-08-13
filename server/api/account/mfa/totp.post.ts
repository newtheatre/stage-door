import { db, schema } from '@nuxthub/db'
import { eq } from 'drizzle-orm'

/**
 * POST /api/account/mfa/totp — begin TOTP enrolment.
 *
 * Returns the secret and its `otpauth://` URI. Nothing gates a login until
 * `confirmedAt` is set by the confirm endpoint, so an abandoned enrolment
 * can't lock anyone out. Re-enrolling replaces an unconfirmed secret.
 */
export default defineEventHandler(async (event) => {
  const { user } = await requireAccountUser(event)

  const existing = await db.select().from(schema.totpSecrets)
    .where(eq(schema.totpSecrets.userId, user.id)).get()

  if (existing?.confirmedAt) {
    throw createError({
      statusCode: 409,
      statusMessage: 'An authenticator app is already set up — remove it first to enrol a new one',
    })
  }

  const secret = generateTotpSecret()

  await db.insert(schema.totpSecrets)
    .values({ userId: user.id, secret })
    .onConflictDoUpdate({
      target: schema.totpSecrets.userId,
      set: { secret, confirmedAt: null, lastUsedStep: null },
    })

  return { secret, uri: totpUri(secret, user.email) }
})
