/**
 * GET /api/users/:id/export — subject-access bundle (admin) [AUD].
 * Send securely to the verified requester (operations.md).
 */
export default defineEventHandler(async (event) => {
  const { user: admin } = await requireAuthAdmin(event)
  const target = await loadUserOr404(getRouterParam(event, 'id'))

  await writeAudit({
    actorUserId: admin.id,
    action: 'user.exported',
    target: target.id,
  })

  setHeader(event, 'Content-Disposition', `attachment; filename="nnt-account-export-${target.id}.json"`)
  return exportUser(target.id)
})
