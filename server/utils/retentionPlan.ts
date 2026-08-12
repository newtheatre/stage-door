/**
 * Retention sweep decision logic (docs/gdpr-retention.md#inactive-account-
 * retention-sweep) — pure and clock-injected so the cohort rules are
 * exhaustively testable. The task in server/tasks/retention/sweep.ts feeds
 * it and executes (or dry-runs) the plan.
 */

import type { RETENTION_CONFIG } from './retentionConfig'

export interface RetentionCandidate {
  id: string
  /** password IS NULL AND google_sub IS NULL — shadow/guest account. */
  guest: boolean
  hasRoles: boolean
  /** Already anonymised / undeliverable placeholder — records, not people. */
  anonymised: boolean
  /** Epoch ms of last login, null = never. */
  lastLogin: number | null
  createdAt: number
  /** Max last-activity across app hooks (bookings etc.), null = none known. */
  lastActivity: number | null
  /** Sent warning timestamps, if any. */
  warning60SentAt: number | null
  warning30SentAt: number | null
}

export interface RetentionPlan {
  anonymise: { id: string, cohort: 'guest' | 'full' }[]
  sendWarning60: string[]
  sendWarning30: string[]
  /** Users who became active again after a warning — reset their notices. */
  clearNotices: string[]
  skipped: { roleHolders: number, anonymised: number, active: number, capped: number }
}

const DAY_MS = 24 * 60 * 60 * 1000

export function planRetention(
  candidates: RetentionCandidate[],
  config: typeof RETENTION_CONFIG,
  now: number,
): RetentionPlan {
  const plan: RetentionPlan = {
    anonymise: [],
    sendWarning60: [],
    sendWarning30: [],
    clearNotices: [],
    skipped: { roleHolders: 0, anonymised: 0, active: 0, capped: 0 },
  }

  for (const user of candidates) {
    if (user.anonymised) {
      plan.skipped.anonymised += 1
      continue
    }
    if (user.hasRoles) {
      // Exempt while roles are held; handover removes roles, then the
      // normal clocks apply.
      plan.skipped.roleHolders += 1
      continue
    }

    if (user.guest) {
      // Guests: no account relationship to warn about — anonymise directly
      // once every activity signal is past the threshold. No known activity
      // at all falls back to account age.
      const activity = Math.max(user.lastActivity ?? 0, user.createdAt)
      if (now - activity > config.guestInactivityMs) {
        plan.anonymise.push({ id: user.id, cohort: 'guest' })
      }
      else {
        plan.skipped.active += 1
      }
      continue
    }

    // Full accounts (password and/or Google): the clock is last login.
    // Google-linked accounts need no special case — once Workspace deletion
    // ends their SSO upstream, they simply stop logging in.
    const lastSeen = Math.max(user.lastLogin ?? 0, user.createdAt)

    if (now - lastSeen <= config.fullInactivityMs) {
      // Active. If they'd been warned before this activity, reset the trail.
      if (user.warning60SentAt !== null || user.warning30SentAt !== null) {
        plan.clearNotices.push(user.id)
      }
      else {
        plan.skipped.active += 1
      }
      continue
    }

    // A login AFTER a warning resets the trail even while past the
    // threshold-by-config change edge cases; handled above by the ≤ check —
    // here the account is genuinely inactive.
    if (user.warning60SentAt === null) {
      plan.sendWarning60.push(user.id)
    }
    else if (user.warning30SentAt === null) {
      if (now - user.warning60SentAt >= (config.warningDays - config.reminderDays) * DAY_MS) {
        plan.sendWarning30.push(user.id)
      }
    }
    else if (now - user.warning60SentAt >= config.warningDays * DAY_MS) {
      plan.anonymise.push({ id: user.id, cohort: 'full' })
    }
  }

  if (plan.anonymise.length > config.maxActionsPerRun) {
    plan.skipped.capped = plan.anonymise.length - config.maxActionsPerRun
    plan.anonymise = plan.anonymise.slice(0, config.maxActionsPerRun)
  }

  return plan
}
