import { db, schema } from '@nuxthub/db'
import { and, eq, isNotNull } from 'drizzle-orm'
import { z } from 'zod/v4'

const bodySchema = z.object({
  attemptId: z.string().min(1),
  code: z.string().trim().min(1).max(64),
})

/**
 * POST /api/auth/mfa/verify — complete a login with a second factor [RL].
 *
 * Accepts either a TOTP code or a recovery code; both are consumed
 * single-use. Only this endpoint (and the WebAuthn authenticate handler)
 * may turn a pending login into a session.
 */
export default defineEventHandler(async (event) => {
  const { attemptId, code } = await readValidatedBody(event, bodySchema.parse)

  await enforceRateLimit('mfa:ip', getClientIP(event))

  const user = await consumeMfaAttempt(attemptId)
  if (!user) {
    throw createError({ statusCode: 400, statusMessage: 'That sign-in attempt expired — please log in again' })
  }

  await enforceRateLimit('mfa:acct', user.id)

  const totp = await db.select().from(schema.totpSecrets)
    .where(and(eq(schema.totpSecrets.userId, user.id), isNotNull(schema.totpSecrets.confirmedAt)))
    .get()

  let accepted = false
  let viaRecovery = false

  if (totp) {
    const result = await verifyTotp(totp.secret, code, { lastUsedStep: totp.lastUsedStep })
    if (result.valid) {
      accepted = true
      await db.update(schema.totpSecrets)
        .set({ lastUsedStep: result.step })
        .where(eq(schema.totpSecrets.userId, user.id))
    }
  }

  if (!accepted && await useRecoveryCode(user.id, code)) {
    accepted = true
    viaRecovery = true
  }

  if (!accepted) {
    // Re-issue the attempt so a typo doesn't force the whole password step
    // again — the rate limits above are what bound guessing.
    throw createError({
      statusCode: 401,
      statusMessage: 'That code was not correct',
      data: { attemptId: await createMfaAttempt(user.id) },
    })
  }

  if (viaRecovery) {
    await writeAudit({
      actorUserId: user.id,
      action: 'mfa.recovery-code-used',
      target: user.id,
      detail: { remaining: await remainingRecoveryCodes(user.id) },
    })
  }

  await sealLoginSession(event, user)
  const { user: sessionUser } = await getUserSession(event)

  return { user: sessionUser, usedRecoveryCode: viaRecovery }
})
