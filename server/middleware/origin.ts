/**
 * CSRF protection: origin check on state-changing API requests
 * (docs/security.md — sameSite: lax is the first layer, this is the second).
 *
 * Browser requests must carry an Origin within the estate. Server-to-server
 * calls authenticated with a service token send no Origin and are exempt —
 * they don't ride on cookies, so CSRF doesn't apply to them.
 */

const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

const ESTATE_ORIGIN = /^https:\/\/([a-z0-9-]+\.)?newtheatre\.org\.uk$/

export default defineEventHandler((event) => {
  if (!UNSAFE_METHODS.has(event.method)) return
  if (!event.path.startsWith('/api/')) return

  // Bearer-authenticated (service token) requests carry no cookies.
  const authorization = getRequestHeader(event, 'authorization')
  if (authorization?.startsWith('Bearer ')) return

  const origin = getRequestHeader(event, 'origin')

  // Same-origin form posts and fetches always carry Origin in modern
  // browsers; its absence means a non-browser client, which cookies-based
  // CSRF can't target. Allow it through — the session check still applies.
  if (!origin) return

  if (ESTATE_ORIGIN.test(origin)) return

  if (import.meta.dev && origin.startsWith('http://localhost')) return

  throw createError({
    statusCode: 403,
    statusMessage: 'Cross-origin request rejected',
  })
})
