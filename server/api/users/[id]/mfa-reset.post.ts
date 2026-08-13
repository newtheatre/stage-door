/**
 * POST /api/users/:id/mfa-reset — clear every second factor (admin) [AUD].
 *
 * The "lost their phone" path (docs/operations.md). Verify identity out of
 * band first — this removes the protection entirely until they re-enrol,
 * and for a privileged account the admin guard will block admin work until
 * they do.
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
