/** Grants that reference nothing an app reads (ADR-0023). */
export default defineEventHandler(async (event) => {
  await requireAuthAdmin(event)
  setHeader(event, 'Cache-Control', 'private, max-age=60')

  const suspects = await findSuspectGrants()
  return { suspects: suspects.map(s => ({ ...s, explanation: explain(s.problem) })) }
})
