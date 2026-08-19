/**
 * Roles v2 configuration (ADR-0011) — committee-ratifiable values live here,
 * not in code paths, mirroring retentionConfig.ts.
 */

export const ROLES_CONFIG = {
  /**
   * Committee year end (UTC). A grant made now expires at the NEXT one, so
   * handover stops depending on anyone remembering to revoke.
   */
  committeeYearEnd: { month: 7, day: 31 },

  /** Warn holders this many days before a grant expires. */
  expiryWarningDays: 14,

  /** Where the expiry digest goes (same recipient as the retention digest). */
  digestEmail: 'archive@newtheatre.org.uk',

  /**
   * Namespaces with no app behind them on purpose, so their definition-less
   * grants are history rather than mistakes (ADR-0010, ADR-0021).
   */
  dormantNamespaces: ['ticketing'] as string[],

  /**
   * Cosmetic cleanup only (0 disables) — read-time enforcement already makes
   * an expired grant inert. 90 days keeps one-click renewal available.
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
