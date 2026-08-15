// Pages for logged-out visitors. A logged-in user goes to their validated
// redirect target, or the account home.
export default defineNuxtRouteMiddleware((to) => {
  const { loggedIn } = useUserSession()

  if (loggedIn.value) {
    const target = typeof to.query.redirect === 'string' && to.query.redirect
      ? validateRedirect(to.query.redirect)
      : '/'
    return navigateTo(target, { external: target.startsWith('https://') })
  }
})
