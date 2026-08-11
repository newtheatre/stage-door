/**
 * GET /api/session/refresh?redirect=<url> — browser-facing refresh.
 *
 * Consumer apps' privileged middleware sends the browser here when the
 * session's roles are stale; on success the re-sealed cookie rides the 302
 * back to the validated target. Rejected sessions bounce to login with the
 * same target preserved.
 */
export default defineEventHandler(async (event) => {
  const target = validateRedirect(getQuery(event).redirect)

  const result = await refreshSession(event)

  if (!result.ok) {
    return sendRedirect(event, `/login?redirect=${encodeURIComponent(target)}`, 302)
  }

  return sendRedirect(event, target, 302)
})
