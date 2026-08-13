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

  // The admin API would 403 an admin who must have a second factor but has
  // none (ADR-0012) — an empty admin page with no explanation. Send them to
  // the fix instead. UX only: if the check itself fails, let them through
  // and the server-side gate decides.
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
