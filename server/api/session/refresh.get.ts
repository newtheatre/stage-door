/**
 * Browser-facing refresh: the re-sealed cookie rides the 302 back to the
 * validated target. Rejected sessions bounce to login.
 */
export default defineEventHandler(async (event) => {
  const target = validateRedirect(getQuery(event).redirect)

  const result = await refreshSession(event)

  if (!result.ok) {
    return sendRedirect(event, `/login?redirect=${encodeURIComponent(target)}`, 302)
  }

  return sendRedirect(event, target, 302)
})
