import { describe, expect, it } from 'vitest'
import { planRetention } from '../server/utils/retentionPlan'
import type { RetentionCandidate } from '../server/utils/retentionPlan'
import { RETENTION_CONFIG } from '../server/utils/retentionConfig'

const DAY = 24 * 60 * 60 * 1000
const YEAR = 365 * DAY
const NOW = Date.UTC(2026, 7, 12)

function candidate(overrides: Partial<RetentionCandidate>): RetentionCandidate {
  return {
    id: overrides.id ?? 'u1',
    guest: false,
    hasRoles: false,
    anonymised: false,
    lastLogin: null,
    createdAt: NOW - 5 * YEAR,
    lastActivity: null,
    warning60SentAt: null,
    warning30SentAt: null,
    ...overrides,
  }
}

const config = RETENTION_CONFIG

describe('retention planner: cohorts (docs/gdpr-retention.md)', () => {
  it('exempts role holders and already-anonymised rows entirely', () => {
    const plan = planRetention([
      candidate({ id: 'admin', hasRoles: true, lastLogin: NOW - 10 * YEAR }),
      candidate({ id: 'anon', anonymised: true }),
    ], config, NOW)

    expect(plan.anonymise).toEqual([])
    expect(plan.sendWarning60).toEqual([])
    expect(plan.skipped.roleHolders).toBe(1)
    expect(plan.skipped.anonymised).toBe(1)
  })

  it('guests: anonymised directly after 3 years without activity, no warnings', () => {
    const plan = planRetention([
      candidate({ id: 'old-guest', guest: true, lastActivity: NOW - 4 * YEAR }),
      candidate({ id: 'recent-guest', guest: true, lastActivity: NOW - 1 * YEAR }),
      // No known activity: falls back to account age.
      candidate({ id: 'silent-old', guest: true, createdAt: NOW - 4 * YEAR }),
      candidate({ id: 'silent-new', guest: true, createdAt: NOW - 1 * YEAR }),
    ], config, NOW)

    expect(plan.anonymise.map(a => a.id).sort()).toEqual(['old-guest', 'silent-old'])
    expect(plan.anonymise.every(a => a.cohort === 'guest')).toBe(true)
    expect(plan.sendWarning60).toEqual([])
  })

  it('guests: recent app activity outweighs an old creation date', () => {
    const plan = planRetention([
      candidate({ id: 'g', guest: true, createdAt: NOW - 6 * YEAR, lastActivity: NOW - 1 * YEAR }),
    ], config, NOW)
    expect(plan.anonymise).toEqual([])
  })

  it('full accounts: warn at 2 years, remind 30 days later, anonymise at 60', () => {
    const inactive = { lastLogin: NOW - 3 * YEAR }

    // Stage 1: nothing sent yet → first warning.
    let plan = planRetention([candidate({ id: 'u', ...inactive })], config, NOW)
    expect(plan.sendWarning60).toEqual(['u'])
    expect(plan.anonymise).toEqual([])

    // Stage 2: warning sent 29 days ago → nothing yet; 30 days → reminder.
    plan = planRetention([candidate({ id: 'u', ...inactive, warning60SentAt: NOW - 29 * DAY })], config, NOW)
    expect(plan.sendWarning30).toEqual([])
    plan = planRetention([candidate({ id: 'u', ...inactive, warning60SentAt: NOW - 30 * DAY })], config, NOW)
    expect(plan.sendWarning30).toEqual(['u'])

    // Stage 3: both sent, 59 days → not yet; 60 days → anonymise.
    plan = planRetention([candidate({ id: 'u', ...inactive, warning60SentAt: NOW - 59 * DAY, warning30SentAt: NOW - 29 * DAY })], config, NOW)
    expect(plan.anonymise).toEqual([])
    plan = planRetention([candidate({ id: 'u', ...inactive, warning60SentAt: NOW - 60 * DAY, warning30SentAt: NOW - 30 * DAY })], config, NOW)
    expect(plan.anonymise).toEqual([{ id: 'u', cohort: 'full' }])
  })

  it('a login after a warning clears the trail instead of progressing it', () => {
    const plan = planRetention([
      candidate({ id: 'saved', lastLogin: NOW - 1 * DAY, warning60SentAt: NOW - 40 * DAY }),
    ], config, NOW)

    expect(plan.clearNotices).toEqual(['saved'])
    expect(plan.sendWarning30).toEqual([])
    expect(plan.anonymise).toEqual([])
  })

  it('google-linked accounts use the same full-account clock (no special case)', () => {
    const plan = planRetention([
      candidate({ id: 'sso', guest: false, lastLogin: NOW - 3 * YEAR }),
    ], config, NOW)
    expect(plan.sendWarning60).toEqual(['sso'])
  })

  it('caps anonymisations per run and reports the overflow', () => {
    const many = Array.from({ length: config.maxActionsPerRun + 50 }, (_, i) =>
      candidate({ id: `g${i}`, guest: true, lastActivity: NOW - 4 * YEAR }))

    const plan = planRetention(many, config, NOW)
    expect(plan.anonymise).toHaveLength(config.maxActionsPerRun)
    expect(plan.skipped.capped).toBe(50)
  })
})
