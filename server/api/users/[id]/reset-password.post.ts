/**
 * Admin-initiated reset: 24 h token, emailed. Cannot target yourself, which
 * keeps the audit trail honest.
 */
export default defineEventHandler(async (event) => {
  const { user: admin } = await requireAuthAdmin(event)
  const user = await loadUserOr404(getRouterParam(event, 'id'), {
    notSelf: { actorId: admin.id, message: 'Use the forgot-password flow for your own account' },
  })

  assertNotAnonymised(user)
  assertPasswordAllowed(user.email)

  const token = await createPasswordResetToken(user.id, TOKEN_EXPIRY.ADMIN_PASSWORD_RESET)
  await sendPasswordResetEmail(user.email, token)

  await writeAudit({
    actorUserId: admin.id,
    action: 'user.admin-reset-requested',
    target: user.id,
  })

  return { ok: true }
})
