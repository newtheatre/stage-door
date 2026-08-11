/**
 * POST /api/auth/logout — end the current session.
 *
 * Clears the domain-wide `nnt-session` cookie. Consumer apps POST here (or
 * to /logout for the redirecting variant); they never clear the cookie
 * themselves (CLAUDE.md invariant 1).
 */
export default defineEventHandler(async (event) => {
  await clearUserSession(event)

  return { ok: true }
})
