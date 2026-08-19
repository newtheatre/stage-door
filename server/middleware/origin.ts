/**
 * CSRF: origin check on every state-changing cookie-authenticated request
 * (docs/security.md). Scoped by what it protects, not by path prefix.
 */

const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

const ESTATE_ORIGIN = /^https:\/\/([a-z0-9-]+\.)?newtheatre\.org\.uk$/

/**
 * The only routes authenticated by a service token rather than the cookie.
 * Named, so a Bearer header cannot exempt a cookie-authenticated route.
 */
const SERVICE_TOKEN_ROUTES = new Set(['/api/users/shadow', '/api/apps/sync'])

export default defineEventHandler((event) => {
  if (!UNSAFE_METHODS.has(event.method)) return

  // Not `/api/` alone: server/routes holds browser flows too, and /logout is
  // cookie-authenticated and state-changing.
  if (SERVICE_TOKEN_ROUTES.has(event.path.split('?')[0]!)) return

  const origin = getRequestHeader(event, 'origin')

  // No Origin means a non-browser client, which cookie CSRF cannot target.
  // The session check still applies.
  if (!origin) return

  if (ESTATE_ORIGIN.test(origin)) return

  if (import.meta.dev && origin.startsWith('http://localhost')) return

  throw createError({
    statusCode: 403,
    statusMessage: 'Cross-origin request rejected',
  })
})
