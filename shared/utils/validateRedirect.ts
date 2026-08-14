/**
 * Redirect validation — CLAUDE.md invariant 6. Anything off the estate
 * allowlist falls back to the apex, and is never reflected back.
 */

/** `https://newtheatre.org.uk` or `https://<sub>.newtheatre.org.uk`, path optional. */
const REDIRECT_ALLOWLIST = /^https:\/\/([a-z0-9-]+\.)?newtheatre\.org\.uk(\/|$)/

const APEX = 'https://newtheatre.org.uk'

/**
 * In development, same-origin relative paths are also allowed so local flows
 * work without a deployed estate.
 */
export function validateRedirect(target: unknown): string {
  if (typeof target !== 'string' || target.length === 0) return APEX

  if (REDIRECT_ALLOWLIST.test(target)) return target

  if (import.meta.dev && /^\/(?!\/)/.test(target)) return target

  return APEX
}
