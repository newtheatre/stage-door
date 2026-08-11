/**
 * POST /logout — browser-facing logout: clear the estate-wide session and
 * bounce to a validated redirect target (consumer apps point their logout
 * forms here). The JSON variant is POST /api/auth/logout.
 */
export default defineEventHandler(async (event) => {
  await clearUserSession(event)

  const { redirect } = getQuery(event)
  return sendRedirect(event, validateRedirect(redirect), 302)
})
