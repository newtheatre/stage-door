import { db, schema } from '@nuxthub/db'
import { and, eq, isNotNull } from 'drizzle-orm'

/**
 * Remove one of your own factors. `:id` is a passkey row id or `totp`.
 * Refuses to remove the last factor while MFA is required of the account.
 */
export default defineEventHandler(async (event) => {
  const { user } = await requireAccountUser(event)
  const id = getRouterParam(event, 'id')!

  // enrolledFactors returns kinds, so its length is at most 2. Counting
  // credentials is what tells us whether this is genuinely the last one.
  const [totp, passkeys] = await Promise.all([
    db.select().from(schema.totpSecrets)
      .where(and(eq(schema.totpSecrets.userId, user.id), isNotNull(schema.totpSecrets.confirmedAt))).get(),
    db.select({ id: schema.webauthnCredentials.id }).from(schema.webauthnCredentials)
      .where(eq(schema.webauthnCredentials.userId, user.id)).all(),
  ])

  if (id !== 'totp' && !passkeys.some(p => p.id === id)) {
    throw createError({ statusCode: 404, statusMessage: 'Passkey not found' })
  }

  const remaining = id === 'totp'
    ? passkeys.length
    : (totp ? 1 : 0) + passkeys.filter(p => p.id !== id).length

  if (remaining === 0 && await isMfaRequired(user)) {
    throw createError({
      statusCode: 400,
      statusMessage: 'This is your only second factor and your account requires one: set up another first',
    })
  }

  // Removing the last factor takes the recovery codes with it, the way
  // clearAllFactors does: they are a factor, and re-enrolment issues fresh ones.
  const alsoCodes = remaining === 0
    ? [db.delete(schema.mfaRecoveryCodes).where(eq(schema.mfaRecoveryCodes.userId, user.id))]
    : []

  if (id === 'totp') {
    await db.batch([
      db.delete(schema.totpSecrets).where(eq(schema.totpSecrets.userId, user.id)),
      ...alsoCodes,
    ])
  }
  else {
    await db.batch([
      db.delete(schema.webauthnCredentials)
        .where(and(eq(schema.webauthnCredentials.id, id), eq(schema.webauthnCredentials.userId, user.id))),
      ...alsoCodes,
    ])
  }

  await writeAudit({
    actorUserId: user.id,
    action: 'mfa.factor-removed',
    target: user.id,
    detail: { factor: id === 'totp' ? 'totp' : 'passkey' },
  })

  return { ok: true }
})
