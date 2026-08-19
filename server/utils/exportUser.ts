/**
 * Right of access — the subject-access bundle (docs/gdpr-retention.md).
 * Auth record + each registered app's export-hook contribution.
 */

import { db, schema } from '@nuxthub/db'
import { eq, or } from 'drizzle-orm'

export async function exportUser(userId: string) {
  const user = await db.select().from(schema.users).where(eq(schema.users.id, userId)).get()
  if (!user) {
    throw createError({ statusCode: 404, statusMessage: 'User not found' })
  }

  // Full grants, expired included — grant notes and provenance are personal
  // data and belong in the bundle (ADR-0011).
  const roleGrants = await loadRoleGrants(userId)
  const legacyIds = await db.select({
    source: schema.legacyIds.source,
    legacyId: schema.legacyIds.legacyId,
  }).from(schema.legacyIds).where(eq(schema.legacyIds.userId, userId)).all()

  // `detail` on a row this user merely acted on describes someone else, so
  // only rows targeting them carry it (docs/gdpr-retention.md).
  const auditRows = await db.select({
    action: schema.auditLog.action,
    detail: schema.auditLog.detail,
    createdAt: schema.auditLog.createdAt,
    target: schema.auditLog.target,
  }).from(schema.auditLog)
    .where(or(eq(schema.auditLog.target, userId), eq(schema.auditLog.actorUserId, userId)))
    .all()

  const auditEntries = auditRows.map(({ target, detail, ...row }) => ({
    ...row,
    detail: target === userId ? detail : null,
  }))

  // Second factors: types and dates only — never a secret or a public key
  // (ADR-0012).
  const totp = await db.select().from(schema.totpSecrets).where(eq(schema.totpSecrets.userId, userId)).get()
  const mfa = {
    totp: totp?.confirmedAt ? { enrolledAt: totp.confirmedAt } : null,
    passkeys: (await listPasskeys(userId)).map(p => ({
      name: p.name,
      createdAt: new Date(p.createdAt),
      lastUsedAt: p.lastUsedAt === null ? null : new Date(p.lastUsedAt),
    })),
    recoveryCodesRemaining: await remainingRecoveryCodes(userId),
  }

  const hooks = await callAllAppHooks<{ data: unknown }>('export', { userId })

  return {
    exportedAt: new Date().toISOString(),
    account: {
      id: user.id,
      email: user.email,
      name: user.name,
      emailVerified: user.verified,
      googleLinked: user.googleSub !== null,
      disabled: user.disabled,
      createdAt: user.createdAt,
      lastLogin: user.lastLogin,
      roles: roleGrants,
      legacyIds,
      mfa,
    },
    auditEntries,
    // Hooks answer { data: <app-held personal data> } — unwrap per contract.
    apps: Object.fromEntries(hooks.map(h => [h.app, h.ok ? h.data?.data : { error: `export unavailable: ${h.error}` }])),
  }
}
