/**
 * Clear every second factor — the "lost their phone" path. Verify identity
 * out of band first; this removes the protection until they re-enrol.
 */
export default defineEventHandler(async (event) => {
  const { user: admin } = await requireAuthAdmin(event)
  const user = await loadUserOr404(getRouterParam(event, 'id'))

  await clearAllFactors(user.id)

  await writeAudit({
    actorUserId: admin.id,
    action: 'mfa.admin-reset',
    target: user.id,
  })

  return { ok: true }
})
