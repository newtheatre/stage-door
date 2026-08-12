/**
 * Retention sweep configuration (docs/gdpr-retention.md).
 *
 * Periods live here, not in code paths, because the committee ratifies
 * them — record adopted values here AND in the data-protection policy.
 * All values are PROPOSALS until ratified.
 */

export const RETENTION_CONFIG = {
  /**
   * Dry-run: the sweep computes and reports what it WOULD do (audit log +
   * digest email) but changes nothing. Must stay true until the Archivist
   * has reviewed a production dry-run report, and set back to true after
   * any period change below.
   */
  dryRun: true,

  /** Shadow/guest accounts: anonymise after this long with no app activity. */
  guestInactivityMs: 3 * 365 * 24 * 60 * 60 * 1000, // 3 years

  /** Full accounts: start warning after this long with no login. */
  fullInactivityMs: 2 * 365 * 24 * 60 * 60 * 1000, // 2 years

  /** Days between first warning and anonymisation, and when the reminder goes. */
  warningDays: 60,
  reminderDays: 30,

  /** Where the digest goes. Its absence is an alert (operations.md#monitoring). */
  archivistEmail: 'archive@newtheatre.org.uk',

  /** How many accounts one sweep run may anonymise (safety valve). */
  maxActionsPerRun: 200,
} as const
