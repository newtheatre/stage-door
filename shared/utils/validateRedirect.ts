/**
 * Redirect target validation — CLAUDE.md invariant 6.
 *
 * Every `?redirect=` in the service goes through this, server- and
 * client-side. Anything not matching the estate allowlist — including
 * protocol-relative URLs, `javascript:`, and lookalike domains — falls back
 * to the apex. The rejected value is never reflected anywhere.
 */

/** `https://newtheatre.org.uk` or `https://<sub>.newtheatre.org.uk`, path optional. */
const REDIRECT_ALLOWLIST = /^https:\/\/([a-z0-9-]+\.)?newtheatre\.org\.uk(\/|$)/

const APEX = 'https://newtheatre.org.uk'

/**
 * Validate a redirect target against the estate allowlist.
 *
 * In development, same-origin relative paths (`/account`, not `//host`) are
 * also allowed so local flows work without a deployed estate.
 */
export function validateRedirect(target: unknown): string {
  if (typeof target !== 'string' || target.length === 0) return APEX

  if (REDIRECT_ALLOWLIST.test(target)) return target

  if (import.meta.dev && /^\/(?!\/)/.test(target)) return target

  return APEX
}
