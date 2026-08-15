/**
 * End the current session. Consumer apps POST here; they never clear the
 * shared cookie themselves (CLAUDE.md invariant 1).
 */
export default defineEventHandler(async (event) => {
  await clearUserSession(event)

  return { ok: true }
})
