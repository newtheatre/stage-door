/**
 * The validated `?redirect=` target for the current page, and a navigate
 * helper that handles cross-subdomain (external) targets.
 *
 * No `?redirect` at all means the user came here directly (consumer apps
 * always pass one), so they stay on this site — the account home — rather
 * than being ejected to the apex. An *invalid* redirect still falls back to
 * the apex inside validateRedirect (CLAUDE.md invariant 6).
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
