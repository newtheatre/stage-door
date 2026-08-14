import { hasRole } from '@newtheatre/auth-types'

// Admin pages: auth:ADMIN only. The client check is UX; every /api endpoint
// the pages call re-verifies against the database (server/utils/adminGuard).
export default defineNuxtRouteMiddleware(async (to) => {
  const { loggedIn, user } = useUserSession()

  if (!loggedIn.value) {
    return navigateTo({ path: '/login', query: { redirect: to.fullPath } })
  }

  if (!hasRole(user.value, 'auth', 'ADMIN')) {
    return navigateTo('/')
  }

  // Send an admin with no second factor to enrolment rather than to a bare 403
  // (ADR-0012). UX only; the server-side gate is the real check.
  try {
    const mfa = await useRequestFetch()('/api/account/mfa')
    if (mfa.required && mfa.factors.length === 0) {
      return navigateTo('/account?tab=security&error=mfa-required')
    }
  }
  catch {
    // fall through
  }
})
