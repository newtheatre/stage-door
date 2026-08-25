import { describe, expect, it } from 'bun:test'
import { endOfLondonDay, formatDate, formatDateLong, formatDateTime, londonDay } from '../shared/utils/formatDate'
import { nextCommitteeYearEnd } from '../server/utils/rolesConfig'

// The last instant of 31 July 2026 in London. 31 July is inside BST, so the
// naive Date.UTC(...23:59:59) this replaces actually fell on 1 August.
const COMMITTEE_YEAR_END = endOfLondonDay(2026, 7, 31).getTime()

describe('dates are pinned to Europe/London', () => {
  it('renders a committee-year expiry as 31 July, not 1 August', () => {
    expect(formatDate(COMMITTEE_YEAR_END)).toBe('31 Jul 2026')
    expect(formatDateLong(COMMITTEE_YEAR_END)).toBe('31 July 2026')
  })

  it('does not drift with the host timezone', () => {
    const original = process.env.TZ
    try {
      for (const tz of ['UTC', 'Europe/London', 'America/New_York', 'Australia/Sydney']) {
        process.env.TZ = tz
        expect(formatDate(COMMITTEE_YEAR_END)).toBe('31 Jul 2026')
      }
    }
    finally {
      process.env.TZ = original
    }
  })

  it('shows GMT dates unchanged', () => {
    // 1 February is outside BST, so this one was never wrong.
    expect(formatDate(Date.UTC(2026, 1, 1, 12, 0, 0))).toBe('1 Feb 2026')
  })

  it('anchors the committee year end on the intended London day', () => {
    // The naive UTC form is an hour late and renders as the next day.
    expect(formatDate(Date.UTC(2026, 6, 31, 23, 59, 59, 999))).toBe('1 Aug 2026')
    expect(formatDate(COMMITTEE_YEAR_END)).toBe('31 Jul 2026')

    // GMT dates are unaffected: no offset to subtract.
    expect(endOfLondonDay(2026, 1, 31).toISOString()).toBe('2026-01-31T23:59:59.999Z')
    expect(endOfLondonDay(2026, 7, 31).toISOString()).toBe('2026-07-31T22:59:59.999Z')
  })

  it('is what nextCommitteeYearEnd hands out', () => {
    const end = nextCommitteeYearEnd(new Date(Date.UTC(2026, 0, 15)))
    expect(formatDate(end)).toBe('31 Jul 2026')
  })

  it('round-trips a BST expiry through the London day the picker shows', () => {
    // What the admin picked, and what the date field must read back.
    expect(londonDay(COMMITTEE_YEAR_END)).toEqual({ year: 2026, month: 7, day: 31 })
    expect(endOfLondonDay(2026, 7, 31).getTime()).toBe(COMMITTEE_YEAR_END)

    // A naive Date.UTC end-of-day is the NEXT London day inside BST.
    expect(londonDay(Date.UTC(2026, 6, 31, 23, 59, 59, 999))).toEqual({ year: 2026, month: 8, day: 1 })
  })

  it('accepts epoch ms, ISO strings and Date objects alike', () => {
    const iso = new Date(COMMITTEE_YEAR_END).toISOString()
    expect(formatDate(iso)).toBe('31 Jul 2026')
    expect(formatDate(new Date(COMMITTEE_YEAR_END))).toBe('31 Jul 2026')
    expect(formatDateTime(COMMITTEE_YEAR_END)).toContain('31/07/2026')
  })
})
