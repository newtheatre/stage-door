/** GET /api/account/export — self-service subject-access bundle. */
export default defineEventHandler(async (event) => {
  const { user } = await requireAccountUser(event)

  await writeAudit({
    actorUserId: user.id,
    action: 'user.exported',
    target: user.id,
    detail: { via: 'self-service' },
  })

  setHeader(event, 'Content-Disposition', 'attachment; filename="nnt-account-export.json"')
  return exportUser(user.id)
})
