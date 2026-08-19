import { db, schema } from '@nuxthub/db'
import { eq } from 'drizzle-orm'

/**
 * Begin TOTP enrolment. Nothing gates a login until `confirmedAt` is set, so
 * an abandoned enrolment cannot lock anyone out.
 */
export default defineEventHandler(async (event) => {
  const { user } = await requireAccountUser(event)

  const existing = await db.select().from(schema.totpSecrets)
    .where(eq(schema.totpSecrets.userId, user.id)).get()

  if (existing?.confirmedAt) {
    throw createError({
      statusCode: 409,
      statusMessage: 'An authenticator app is already set up: remove it first to enrol a new one',
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
