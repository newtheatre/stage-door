// Pages for logged-out visitors (login, register): a logged-in user is
// bounced straight to their validated redirect target — or the account home
// when none was asked for (same rule as useRedirectTarget).
export default defineNuxtRouteMiddleware((to) => {
  const { loggedIn } = useUserSession()

  if (loggedIn.value) {
    const target = typeof to.query.redirect === 'string' && to.query.redirect
      ? validateRedirect(to.query.redirect)
      : '/'
    return navigateTo(target, { external: target.startsWith('https://') })
  }
})
