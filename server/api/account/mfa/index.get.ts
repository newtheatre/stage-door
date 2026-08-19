/** GET /api/account/mfa: the caller's own factor status. */
export default defineEventHandler(async (event) => {
  const { user } = await requireAccountUser(event)

  const credentials = await listPasskeys(user.id)

  return {
    required: await isMfaRequired(user),
    factors: await enrolledFactors(user.id),
    passkeys: credentials,
    recoveryCodesRemaining: await remainingRecoveryCodes(user.id),
  }
})
