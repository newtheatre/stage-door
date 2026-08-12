import { db, schema } from '@nuxthub/db'
import { and, eq, gt, inArray, isNull, isNotNull, lt, lte } from 'drizzle-orm'

/**
 * Role expiry warnings + cosmetic cleanup (ADR-0011).
 *
 * Daily. Warns holders of grants entering the expiry window (one email per
 * holder covering all their expiring grants) and digests to the ITM. The
 * invariant is one warning per (grant, expiry value): `expiry_warned_at`
 * gates sending, and roles.put clears it whenever an expiry changes, so a
 * renewal re-arms the warning for the new date.
 *
 * Unlike the retention sweep there is deliberately no dry-run mode: the
 * emails are non-destructive, and the cleanup only deletes rows that
 * read-time enforcement already made inert months earlier.
 */
export default defineTask({
  meta: {
    name: 'roles:expiry-warn',
    description: 'Warn holders of expiring role grants; tidy long-expired rows',
  },
  async run() {
    const config = ROLES_CONFIG
    const now = Date.now()
    const windowEnd = new Date(now + config.expiryWarningDays * 24 * 60 * 60 * 1000)

    // Grants entering the window, not yet warned for this expiry value.
    const expiring = await db.select({
      id: schema.userRoles.id,
      userId: schema.userRoles.userId,
      role: schema.userRoles.role,
      expiresAt: schema.userRoles.expiresAt,
      email: schema.users.email,
      disabled: schema.users.disabled,
    }).from(schema.userRoles)
      .innerJoin(schema.users, eq(schema.userRoles.userId, schema.users.id))
      .where(and(
        isNotNull(schema.userRoles.expiresAt),
        gt(schema.userRoles.expiresAt, new Date(now)),
        lte(schema.userRoles.expiresAt, windowEnd),
        isNull(schema.userRoles.expiryWarnedAt),
      ))
      .all()

    // One email per holder; disabled/anonymised holders are marked warned
    // without an email (nothing can arrive, and re-checking daily is noise).
    const byHolder = new Map<string, { email: string, emailable: boolean, grants: { role: string, expiresAt: number }[] }>()
    for (const row of expiring) {
      const entry = byHolder.get(row.userId) ?? {
        email: row.email,
        emailable: !row.disabled && !isUndeliverableEmail(row.email),
        grants: [],
      }
      entry.grants.push({ role: row.role, expiresAt: row.expiresAt!.getTime() })
      byHolder.set(row.userId, entry)
    }

    const digest: { email: string, role: string, expiresAt: number }[] = []
    for (const holder of byHolder.values()) {
      if (holder.emailable) {
        await sendRoleExpiryWarningEmail(holder.email, holder.grants)
        digest.push(...holder.grants.map(g => ({ email: holder.email, ...g })))
      }
    }

    if (expiring.length) {
      await db.update(schema.userRoles)
        .set({ expiryWarnedAt: new Date(now) })
        .where(inArray(schema.userRoles.id, expiring.map(r => r.id)))
    }

    if (digest.length) {
      await sendRoleExpiryDigestEmail(config.digestEmail, digest)
    }

    // Cosmetic cleanup: rows long past expiry (read-time enforcement made
    // them inert; 90 days keeps them renewable through handover).
    let cleaned = 0
    if (config.cleanupAfterDays > 0) {
      const cutoff = new Date(now - config.cleanupAfterDays * 24 * 60 * 60 * 1000)
      const removed = await db.delete(schema.userRoles)
        .where(and(isNotNull(schema.userRoles.expiresAt), lt(schema.userRoles.expiresAt, cutoff)))
        .returning({ id: schema.userRoles.id })
      cleaned = removed.length
    }

    const summary = { warnedGrants: expiring.length, warnedHolders: byHolder.size, emailed: digest.length, cleaned }

    if (expiring.length || cleaned) {
      await writeAudit({
        actorUserId: null,
        action: 'roles.expiry-warned',
        target: 'user_roles',
        detail: summary,
      })
    }

    return { result: summary }
  },
})
