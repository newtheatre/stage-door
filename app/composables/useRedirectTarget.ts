/**
 * The validated `?redirect=` target for the current page, and a navigate
 * helper that handles cross-subdomain (external) targets.
 */
export function useRedirectTarget() {
  const route = useRoute()

  const target = computed(() => validateRedirect(route.query.redirect))

  /** Raw query value, only for propagating between auth pages (login ⇄ register). */
  const raw = computed(() => typeof route.query.redirect === 'string' ? route.query.redirect : undefined)

  function navigateToTarget() {
    return navigateTo(target.value, { external: target.value.startsWith('https://') })
  }

  /** Append the current redirect to an internal auth-page link. */
  function withRedirect(path: string): string {
    return raw.value ? `${path}?redirect=${encodeURIComponent(raw.value)}` : path
  }

  return { target, raw, navigateToTarget, withRedirect }
}
