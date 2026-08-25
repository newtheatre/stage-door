import { db, schema } from '@nuxthub/db'
import { desc, inArray } from 'drizzle-orm'
import { SELF_APP_NAME } from '../../../shared/utils/appManifest'

/** Users whose last erasure attempt reported an app hook still outstanding. */
async function stalledErasures(limit: number): Promise<string[]> {
  const events = await db.select({
    target: schema.auditLog.target,
    action: schema.auditLog.action,
  }).from(schema.auditLog)
    .where(inArray(schema.auditLog.action, ['user.erased', 'user.erase-incomplete']))
    .orderBy(desc(schema.auditLog.createdAt))
    .all()

  const latest = new Map<string, string>()
  for (const e of events) {
    if (e.target && !latest.has(e.target)) latest.set(e.target, e.action)
  }
  return [...latest].filter(([, action]) => action === 'user.erase-incomplete').map(([id]) => id).slice(0, limit)
}

/**
 * The inactive-account retention sweep. Dry-run by default; the digest's
 * absence is the alert. See docs/gdpr-retention.md.
 */
export default defineTask({
  meta: {
    name: 'retention:sweep',
    description: 'Warn and anonymise inactive accounts per the retention config',
  },
  async run() {
    const config = RETENTION_CONFIG
    const now = Date.now()

    // ── Gather candidates ──────────────────────────────────────────────────

    // Named fields, not every column: otherwise every scrypt hash in the
    // estate is pulled into the isolate and discarded.
    const users = await db.select({
      id: schema.users.id,
      email: schema.users.email,
      password: schema.users.password,
      googleSub: schema.users.googleSub,
      disabled: schema.users.disabled,
      lastLogin: schema.users.lastLogin,
      createdAt: schema.users.createdAt,
    }).from(schema.users).all()
    // ACTIVE grants only: an expired role must not exempt anyone (ADR-0011).
    const roleRows = await db.select({ userId: schema.userRoles.userId })
      .from(schema.userRoles).where(activeRoleCondition(new Date(now))).all()
    const roleHolders = new Set(roleRows.map(r => r.userId))
    const notices = await db.select().from(schema.retentionNotices).all()
    const noticesByUser = new Map<string, { w60: number | null, w30: number | null }>()
    for (const n of notices) {
      const entry = noticesByUser.get(n.userId) ?? { w60: null, w30: null }
      if (n.stage === 'warning-60d') entry.w60 = n.sentAt.getTime()
      if (n.stage === 'warning-30d') entry.w30 = n.sentAt.getTime()
      noticesByUser.set(n.userId, entry)
    }

    // Every registered app owes an answer, not just those with hooks on: an
    // app toggled off is one whose activity nobody can see (ADR-0017).
    const owedAnswers = (await db.select({ name: schema.apps.name }).from(schema.apps).all())
      .map(a => a.name)
      .filter(name => name !== SELF_APP_NAME)

    // Guests need app activity signals: batch the last-activity hooks.
    const guestIds = users
      .filter(u => u.password === null && u.googleSub === null && !isUndeliverableEmail(u.email))
      .map(u => u.id)
    const lastActivity = new Map<string, number>()
    const answered = new Set<string>()
    let hookFailure = false
    for (let i = 0; i < guestIds.length && !hookFailure; i += 90) { // D1: 100 bound params max
      const batch = guestIds.slice(i, i + 90)
      const results = await callAllAppHooks<Record<string, number | null>>('last-activity', { userIds: batch })
      for (const result of results) {
        if (!result.ok) {
          // Missing signals must fail SAFE: without every app's answer we
          // cannot prove inactivity, so skip guest anonymisation this run.
          console.error(`[retention] last-activity hook failed for ${result.app}: guest cohort skipped this run`)
          hookFailure = true
          break
        }
        answered.add(result.app)
        for (const [id, ts] of Object.entries(result.data ?? {})) {
          if (ts !== null) lastActivity.set(id, Math.max(lastActivity.get(id) ?? 0, ts))
        }
      }
    }
    // An empty registry, or one app silent, proves nothing: every() over an
    // empty answer set would be vacuously true (docs/gdpr-retention.md).
    const guestSignalsOk = guestIds.length === 0
      || (!hookFailure && owedAnswers.length > 0 && owedAnswers.every(name => answered.has(name)))
    if (!guestSignalsOk && !hookFailure && guestIds.length) {
      console.error(`[retention] only ${answered.size} of ${owedAnswers.length} apps answered: guest cohort skipped this run`)
    }

    const candidates = users.map(u => ({
      id: u.id,
      guest: u.password === null && u.googleSub === null,
      hasRoles: roleHolders.has(u.id),
      anonymised: isUndeliverableEmail(u.email),
      lastLogin: u.lastLogin?.getTime() ?? null,
      createdAt: u.createdAt.getTime(),
      lastActivity: lastActivity.get(u.id) ?? null,
      warning60SentAt: noticesByUser.get(u.id)?.w60 ?? null,
      warning30SentAt: noticesByUser.get(u.id)?.w30 ?? null,
    }))

    let plan = planRetention(candidates, config, now)
    if (!guestSignalsOk) {
      plan = { ...plan, anonymise: plan.anonymise.filter(a => a.cohort !== 'guest') }
    }

    // Paced: Resend rate-limits, and one serial send per dormant account would
    // exhaust the worker's subrequest budget on the first armed run.
    const warning60 = plan.sendWarning60.slice(0, config.maxWarningsPerRun)
    const warning30 = plan.sendWarning30.slice(0, config.maxWarningsPerRun - warning60.length)
    const deferredWarnings = (plan.sendWarning60.length - warning60.length)
      + (plan.sendWarning30.length - warning30.length)

    const summary = {
      dryRun: config.dryRun,
      guestSignalsOk,
      anonymiseGuest: plan.anonymise.filter(a => a.cohort === 'guest').length,
      anonymiseFull: plan.anonymise.filter(a => a.cohort === 'full').length,
      warning60: warning60.length,
      warning30: warning30.length,
      deferredWarnings,
      clearedNotices: plan.clearNotices.length,
      skipped: plan.skipped,
    }

    // ── Finish erasures already committed locally ──────────────────────────

    // Not a retention decision: the member asked for this and their auth row is
    // already scrubbed, so it runs in dry-run too. eraseUser is idempotent.
    const stalled = await stalledErasures(config.maxActionsPerRun)
    const incompleteErasures: string[] = []
    for (const id of stalled) {
      const { complete } = await eraseUser(id, { id: null, via: 'retention-redrive' })
      if (!complete) incompleteErasures.push(id)
    }

    // ── Execute (or don't) ─────────────────────────────────────────────────
    let sendFailures = 0
    if (!config.dryRun) {
      const userById = new Map(users.map(u => [u.id, u]))

      // One bad recipient must not abort the run, or nothing is anonymised, no
      // audit row is written, and the digest never goes out.
      const warn = async (ids: string[], days: number, stage: 'warning-60d' | 'warning-30d') => {
        for (const id of ids) {
          const target = userById.get(id)!
          // Nothing can arrive for a disabled or undeliverable address, but the
          // clock must still run or the account is never anonymised.
          if (!target.disabled && !isUndeliverableEmail(target.email)) {
            try {
              await sendRetentionWarningEmail(target.email, days)
            }
            catch (error) {
              sendFailures += 1
              console.error(`[retention] ${stage} warning to ${target.id} failed:`, error)
              continue
            }
          }
          await db.insert(schema.retentionNotices).values({ userId: id, stage })
        }
      }
      await warn(warning60, config.warningDays, 'warning-60d')
      await warn(warning30, config.reminderDays, 'warning-30d')

      for (let i = 0; i < plan.clearNotices.length; i += 90) { // D1: 100 bound params max
        await db.delete(schema.retentionNotices)
          .where(inArray(schema.retentionNotices.userId, plan.clearNotices.slice(i, i + 90)))
      }

      for (const { id } of plan.anonymise) {
        const { complete } = await eraseUser(id, { id: null, via: 'retention-sweep' })
        if (!complete) incompleteErasures.push(id)
      }
    }

    const report = {
      ...summary,
      sendFailures,
      // The backlog this run started with, and what it could not finish.
      outstandingErasures: stalled.length,
      incompleteErasures: incompleteErasures.length,
    }

    await writeAudit({
      actorUserId: null,
      action: config.dryRun ? 'retention.dry-run' : 'retention.sweep',
      target: 'users',
      detail: report,
    })

    // ── Digest ─────────────────────────────────────────────────────────────
    const hasActions = summary.anonymiseGuest + summary.anonymiseFull + summary.warning60 + summary.warning30 > 0
    const firstOfMonth = new Date(now).getUTCDate() === 1
    if (hasActions || firstOfMonth || config.dryRun || stalled.length || incompleteErasures.length || sendFailures) {
      await sendRetentionDigestEmail(config.archivistEmail, report)
    }

    return { result: report }
  },
})
