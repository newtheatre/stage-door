/**
 * CSRF: origin check on state-changing API requests (docs/security.md).
 * Service-token calls send no Origin and are exempt — they carry no cookie.
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
