// Pages for logged-out visitors (login, register): a logged-in user is
// bounced straight to their validated redirect target.
export default defineNuxtRouteMiddleware((to) => {
  const { loggedIn } = useUserSession()

  if (loggedIn.value) {
    const target = validateRedirect(to.query.redirect)
    return navigateTo(target, { external: target.startsWith('https://') })
  }
})
