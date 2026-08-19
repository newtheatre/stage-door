/**
 * Resend the verification email. The response is identical whether or not a
 * link was actually sent.
 */
export default defineEventHandler(async (event) => {
  // Not requireUserSession: that accepts a cookie force-logout has revoked.
  const { user } = await requireLiveUser(event)

  await enforceRateLimit('verify-request:ip', getClientIP(event))
  await enforceRateLimit('verify-request:acct', user.id)

  if (!user.verified) {
    const token = await createEmailVerificationToken(user.id)
    await sendVerificationEmail(user.email, token)
  }

  return { ok: true }
})
