/**
 * JSON refresh for server-to-server use. Same semantics as the GET variant,
 * but 401 instead of a login redirect.
 */
export default defineEventHandler(async (event) => {
  const result = await refreshSession(event)

  if (!result.ok) {
    throw createError({ statusCode: 401, statusMessage: 'Session no longer valid' })
  }

  return { user: result.user }
})
