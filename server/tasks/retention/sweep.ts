import { db, schema } from '@nuxthub/db'
import { desc, inArray } from 'drizzle-orm'

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
    const users = await db.select().from(schema.users).all()
    // ACTIVE grants only — an expired role must not exempt anyone (ADR-0011).
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

    // Guests need app activity signals — batch the last-activity hooks.
    const guestIds = users
      .filter(u => u.password === null && u.googleSub === null && !isUndeliverableEmail(u.email))
      .map(u => u.id)
    const lastActivity = new Map<string, number>()
    let hookFailure = false
    for (let i = 0; i < guestIds.length && !hookFailure; i += 90) { // D1: 100 bound params max
      const batch = guestIds.slice(i, i + 90)
      const results = await callAllAppHooks<Record<string, number | null>>('last-activity', { userIds: batch })
      for (const result of results) {
        if (!result.ok) {
          // Missing signals must fail SAFE: without every app's answer we
          // cannot prove inactivity, so skip guest anonymisation this run.
          console.error(`[retention] last-activity hook failed for ${result.app} — guest cohort skipped this run`)
          hookFailure = true
          break
        }
        for (const [id, ts] of Object.entries(result.data ?? {})) {
          if (ts !== null) lastActivity.set(id, Math.max(lastActivity.get(id) ?? 0, ts))
        }
      }
    }
    const guestSignalsOk = !hookFailure

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

    const summary = {
      dryRun: config.dryRun,
      guestSignalsOk,
      anonymiseGuest: plan.anonymise.filter(a => a.cohort === 'guest').length,
      anonymiseFull: plan.anonymise.filter(a => a.cohort === 'full').length,
      warning60: plan.sendWarning60.length,
      warning30: plan.sendWarning30.length,
      clearedNotices: plan.clearNotices.length,
      skipped: plan.skipped,
    }

    // ── Execute (or don't) ─────────────────────────────────────────────────
    const incompleteErasures: string[] = []
    if (!config.dryRun) {
      const emailOf = new Map(users.map(u => [u.id, u.email]))

      for (const id of plan.sendWarning60) {
        await sendRetentionWarningEmail(emailOf.get(id)!, config.warningDays)
        await db.insert(schema.retentionNotices).values({ userId: id, stage: 'warning-60d' })
      }
      for (const id of plan.sendWarning30) {
        await sendRetentionWarningEmail(emailOf.get(id)!, config.reminderDays)
        await db.insert(schema.retentionNotices).values({ userId: id, stage: 'warning-30d' })
      }
      // Unbounded: maxActionsPerRun caps anonymise only.
      for (let i = 0; i < plan.clearNotices.length; i += 90) { // D1: 100 bound params max
        await db.delete(schema.retentionNotices)
          .where(inArray(schema.retentionNotices.userId, plan.clearNotices.slice(i, i + 90)))
      }

      // planRetention skips an already-anonymised row, so a run whose hooks
      // failed is only ever retried from here. eraseUser is idempotent.
      for (const id of await stalledErasures(config.maxActionsPerRun)) {
        const { complete } = await eraseUser(id, { id: null, via: 'retention-redrive' })
        if (!complete) incompleteErasures.push(id)
      }

      for (const { id } of plan.anonymise) {
        const { complete } = await eraseUser(id, { id: null, via: 'retention-sweep' })
        if (!complete) incompleteErasures.push(id)
      }
    }

    const report = { ...summary, incompleteErasures: incompleteErasures.length }

    await writeAudit({
      actorUserId: null,
      action: config.dryRun ? 'retention.dry-run' : 'retention.sweep',
      target: 'users',
      detail: report,
    })

    // ── Digest ─────────────────────────────────────────────────────────────
    const hasActions = summary.anonymiseGuest + summary.anonymiseFull + summary.warning60 + summary.warning30 > 0
    const firstOfMonth = new Date(now).getUTCDate() === 1
    if (hasActions || firstOfMonth || config.dryRun || incompleteErasures.length) {
      await sendRetentionDigestEmail(config.archivistEmail, report)
    }

    return { result: report }
  },
})
