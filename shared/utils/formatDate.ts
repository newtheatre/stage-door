/**
 * Dates are always rendered in Europe/London. The Worker runs in UTC and a
 * browser runs wherever the reader is, so an unpinned date is wrong twice.
 */
const TIME_ZONE = 'Europe/London'

/** A date on its own, e.g. `31 Jul 2026`. */
export function formatDate(value: number | string | Date): string {
  return new Date(value).toLocaleDateString('en-GB', {
    timeZone: TIME_ZONE,
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  })
}

/** The same date with the month spelled out, for email copy. */
export function formatDateLong(value: number | string | Date): string {
  return new Date(value).toLocaleDateString('en-GB', {
    timeZone: TIME_ZONE,
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  })
}

/**
 * The last instant of a London day, as UTC. 31 July is inside BST, so a
 * naive Date.UTC(...23:59:59) lands on 1 August for every UK reader.
 */
export function endOfLondonDay(year: number, month: number, day: number): Date {
  const naive = Date.UTC(year, month - 1, day, 23, 59, 59, 999)
  const local = new Date(new Date(naive).toLocaleString('en-US', { timeZone: TIME_ZONE }))
  const utc = new Date(new Date(naive).toLocaleString('en-US', { timeZone: 'UTC' }))
  return new Date(naive - (local.getTime() - utc.getTime()))
}

/** Date and time, for audit trails and last-seen stamps. */
export function formatDateTime(value: number | string | Date): string {
  return new Date(value).toLocaleString('en-GB', {
    timeZone: TIME_ZONE,
    dateStyle: 'short',
    timeStyle: 'medium',
  })
}
