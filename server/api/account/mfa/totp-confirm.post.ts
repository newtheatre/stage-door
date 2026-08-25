import { db, schema } from '@nuxthub/db'
import { eq, sql } from 'drizzle-orm'
import { z } from 'zod'

const bodySchema = z.object({
  code: z.string().min(6).max(10),
})

/**
 * Prove the authenticator works, and arm it. First confirmation also issues
 * recovery codes, the only time they are shown, and bumps the epoch.
 */
export default defineEventHandler(async (event) => {
  const { user, loggedInAt } = await requireAccountUser(event)
  const { code } = await readValidatedBody(event, bodySchema.parse)

  await enforceRateLimit('mfa:acct', user.id)

  const secret = await db.select().from(schema.totpSecrets)
    .where(eq(schema.totpSecrets.userId, user.id)).get()

  if (!secret) {
    throw createError({ statusCode: 400, statusMessage: 'Start setting up an authenticator app first' })
  }

  const result = await verifyTotp(secret.secret, code, { lastUsedStep: secret.lastUsedStep })
  if (!result.valid) {
    throw createError({ statusCode: 400, statusMessage: 'That code was not correct: check your authenticator app' })
  }

  const firstEnrolment = secret.confirmedAt === null

  const recoveryCodes = firstEnrolment && await remainingRecoveryCodes(user.id) === 0
    ? newRecoveryCodes()
    : null

  // One batch: a half-landed confirmation would arm the factor with codes
  // nobody has seen, and firstEnrolment is then false so no retry re-issues.
  const [[updated]] = await db.batch([
    db.update(schema.users)
      .set({ sessionEpoch: sql`${schema.users.sessionEpoch} + 1` })
      .where(eq(schema.users.id, user.id))
      .returning(),
    db.update(schema.totpSecrets)
      .set({ confirmedAt: new Date(), lastUsedStep: result.step })
      .where(eq(schema.totpSecrets.userId, user.id)),
    ...(recoveryCodes ? recoveryCodeStatements(user.id, recoveryCodes) : []),
  ])

  // Keep this session alive; only the others die.
  await reSealSession(event, updated!, loggedInAt)

  await writeAudit({
    actorUserId: user.id,
    action: 'mfa.totp-enrolled',
    target: user.id,
  })

  return { ok: true, recoveryCodes }
})
