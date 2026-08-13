/**
 * POST /api/account/mfa/recovery-codes — regenerate recovery codes [AUD].
 * Returns the new codes once; the old ones stop working immediately.
 */
export default defineEventHandler(async (event) => {
  const { user } = await requireAccountUser(event)

  if ((await enrolledFactors(user.id)).length === 0) {
    throw createError({ statusCode: 400, statusMessage: 'Set up a second factor before generating recovery codes' })
  }

  const codes = await regenerateRecoveryCodes(user.id)

  await writeAudit({
    actorUserId: user.id,
    action: 'mfa.recovery-codes-regenerated',
    target: user.id,
  })

  return { recoveryCodes: codes }
})
