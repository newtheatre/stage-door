/** GET /api/account/mfa: the caller's own factor status. */
export default defineEventHandler(async (event) => {
  const { user } = await requireAccountUser(event)

  // Independent of each other, and this backs one small page.
  const [roles, factors, credentials, recoveryCodesRemaining] = await Promise.all([
    loadRoles(user.id),
    enrolledFactors(user.id),
    listPasskeys(user.id),
    remainingRecoveryCodes(user.id),
  ])

  return {
    // Roles are in hand, so this does not re-run the eligibility query.
    required: await isMfaRequired(user, roles),
    factors,
    passkeys: credentials,
    recoveryCodesRemaining,
  }
})
