import { hasRole } from '@newtheatre/auth-types'

// Admin pages: auth:ADMIN only. The client check is UX; every /api endpoint
// the pages call re-verifies against the database (server/utils/adminGuard).
export default defineNuxtRouteMiddleware((to) => {
  const { loggedIn, user } = useUserSession()

  if (!loggedIn.value) {
    return navigateTo({ path: '/login', query: { redirect: to.fullPath } })
  }

  if (!hasRole(user.value, 'auth', 'ADMIN')) {
    return navigateTo('/')
  }
})
