/**
 * Browser-facing logout: clear the session and bounce to a validated target.
 * The JSON variant is POST /api/auth/logout.
 */
export default defineEventHandler(async (event) => {
  await clearUserSession(event)

  const { redirect } = getQuery(event)
  return sendRedirect(event, validateRedirect(redirect), 302)
})
