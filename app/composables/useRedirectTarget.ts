/**
 * The validated `?redirect=` target, plus a navigate helper for
 * cross-subdomain targets. No redirect at all means stay on this site.
 */
export function useRedirectTarget() {
  const route = useRoute()

  /** Raw query value, only for propagating between auth pages (login ⇄ register). */
  const raw = computed(() => typeof route.query.redirect === 'string' ? route.query.redirect : undefined)

  const target = computed(() => raw.value ? validateRedirect(raw.value) : '/')

  function navigateToTarget() {
    return navigateTo(target.value, { external: target.value.startsWith('https://') })
  }

  /** Append the current redirect to an internal auth-page link. */
  function withRedirect(path: string): string {
    return raw.value ? `${path}?redirect=${encodeURIComponent(raw.value)}` : path
  }

  return { target, raw, navigateToTarget, withRedirect }
}
