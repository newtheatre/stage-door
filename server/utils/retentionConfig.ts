/**
 * Retention periods, which the committee ratifies — record adopted values
 * here AND in the data-protection policy. All values are PROPOSALS until then.
 */

export const RETENTION_CONFIG = {
  /**
   * Dry-run: report what the sweep WOULD do, change nothing. Set back to true
   * after any period change below.
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
