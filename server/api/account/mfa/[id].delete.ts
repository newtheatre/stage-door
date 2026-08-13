import { db, schema } from '@nuxthub/db'
import { and, eq } from 'drizzle-orm'

/**
 * DELETE /api/account/mfa/:id — remove one of your own factors [AUD].
 * `:id` is a passkey row id, or the literal `totp`.
 *
 * Refuses to remove your last factor while MFA is required of the account:
 * dropping to zero would leave a privileged password account unprotected,
 * and the admin guard would lock you out of admin tools anyway.
 */
export default defineEventHandler(async (event) => {
  const { user } = await requireAccountUser(event)
  const id = getRouterParam(event, 'id')!

  const factorsBefore = await enrolledFactors(user.id)
  const removingLast = factorsBefore.length === 1

  if (removingLast && await isMfaRequired(user)) {
    throw createError({
      statusCode: 400,
      statusMessage: 'This is your only second factor and your account requires one — set up another first',
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
