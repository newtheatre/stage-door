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

  const remaining = id === 'totp'
    ? passkeys.length
    : (totp ? 1 : 0) + passkeys.filter(p => p.id !== id).length

  if (remaining === 0 && await isMfaRequired(user)) {
    throw createError({
      statusCode: 400,
      statusMessage: 'This is your only second factor and your account requires one: set up another first',
    })
  }

  if (id === 'totp') {
    await db.delete(schema.totpSecrets).where(eq(schema.totpSecrets.userId, user.id))
  }
  else {
    const [removed] = await db.delete(schema.webauthnCredentials)
      .where(and(eq(schema.webauthnCredentials.id, id), eq(schema.webauthnCredentials.userId, user.id)))
      .returning()
    if (!removed) throw createError({ statusCode: 404, statusMessage: 'Passkey not found' })
  }

  await writeAudit({
    actorUserId: user.id,
    action: 'mfa.factor-removed',
    target: user.id,
    detail: { factor: id === 'totp' ? 'totp' : 'passkey' },
  })

  return { ok: true }
})
