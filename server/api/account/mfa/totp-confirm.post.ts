import { db, schema } from '@nuxthub/db'
import { eq, sql } from 'drizzle-orm'
import { z } from 'zod/v4'

const bodySchema = z.object({
  code: z.string().min(6).max(10),
})

/**
 * Prove the authenticator works, and arm it. First confirmation also issues
 * recovery codes — the only time they are shown — and bumps the epoch.
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
    throw createError({ statusCode: 400, statusMessage: 'That code was not correct — check your authenticator app' })
  }

  const firstEnrolment = secret.confirmedAt === null

  await db.update(schema.totpSecrets)
    .set({ confirmedAt: new Date(), lastUsedStep: result.step })
    .where(eq(schema.totpSecrets.userId, user.id))

  const recoveryCodes = firstEnrolment && await remainingRecoveryCodes(user.id) === 0
    ? await regenerateRecoveryCodes(user.id)
    : null

  const [updated] = await db.update(schema.users)
    .set({ sessionEpoch: sql`${schema.users.sessionEpoch} + 1` })
    .where(eq(schema.users.id, user.id))
    .returning()

  // Keep this session alive; only the others die.
  await sealUserSession(event, updated!, await loadRoles(user.id), { fresh: false, loggedInAt })

  await writeAudit({
    actorUserId: user.id,
    action: 'mfa.totp-enrolled',
    target: user.id,
  })

  return { ok: true, recoveryCodes }
})
