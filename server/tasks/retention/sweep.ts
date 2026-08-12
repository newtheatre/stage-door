import { db, schema } from '@nuxthub/db'
import { inArray } from 'drizzle-orm'

/**
 * The inactive-account retention sweep (docs/gdpr-retention.md).
 *
 * Runs daily; decisions come from the pure planner. In dry-run mode
 * (RETENTION_CONFIG.dryRun — the default, and mandatory after any config
 * change) it audits and emails what it WOULD do without changing anything.
 * Digest email goes to the Archivist whenever there are (planned) actions,
 * and always on the 1st of the month as a heartbeat — its absence is an
 * alert (operations.md#monitoring).
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
    const roleRows = await db.select({ userId: schema.userRoles.userId }).from(schema.userRoles).all()
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
    for (let i = 0; i < guestIds.length && !hookFailure; i += 500) {
      const batch = guestIds.slice(i, i + 500)
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
      if (plan.clearNotices.length) {
        await db.delete(schema.retentionNotices)
          .where(inArray(schema.retentionNotices.userId, plan.clearNotices))
      }
      for (const { id } of plan.anonymise) {
        await eraseUser(id, { id: null, via: 'retention-sweep' })
      }
    }

    await writeAudit({
      actorUserId: null,
      action: config.dryRun ? 'retention.dry-run' : 'retention.sweep',
      target: 'users',
      detail: summary,
    })

    // ── Digest ─────────────────────────────────────────────────────────────
    const hasActions = summary.anonymiseGuest + summary.anonymiseFull + summary.warning60 + summary.warning30 > 0
    const firstOfMonth = new Date(now).getUTCDate() === 1
    if (hasActions || firstOfMonth || config.dryRun) {
      await sendRetentionDigestEmail(config.archivistEmail, summary)
    }

    return { result: summary }
  },
})
