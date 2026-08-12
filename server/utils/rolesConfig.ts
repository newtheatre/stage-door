/**
 * Roles v2 configuration (ADR-0011) — committee-ratifiable values live here,
 * not in code paths, mirroring retentionConfig.ts.
 */

export const ROLES_CONFIG = {
  /**
   * Committee year end (UTC). Grants made with the end-of-committee-year
   * default expire at 23:59:59 UTC on the NEXT such date — granted October
   * 2026 → expires 31 July 2027; handover stops depending on anyone
   * remembering to revoke.
   */
  committeeYearEnd: { month: 7, day: 31 },

  /** Warn holders this many days before a grant expires. */
  expiryWarningDays: 14,

  /** Where the expiry digest goes (same recipient as the retention digest). */
  digestEmail: 'archive@newtheatre.org.uk',

  /**
   * Cosmetic cleanup: delete grants expired longer than this many days
   * (0 disables). Read-time enforcement makes this optional; 90 days keeps
   * recently-expired grants visible in the admin UI for one-click renewal
   * through the handover period.
   */
  cleanupAfterDays: 90,
} as const

/** The next committee year end strictly after `now`. */
export function nextCommitteeYearEnd(now: Date = new Date()): Date {
  const { month, day } = ROLES_CONFIG.committeeYearEnd
  const candidate = new Date(Date.UTC(now.getUTCFullYear(), month - 1, day, 23, 59, 59, 999))
  return candidate > now
    ? candidate
    : new Date(Date.UTC(now.getUTCFullYear() + 1, month - 1, day, 23, 59, 59, 999))
}
