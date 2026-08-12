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

  const roles = await loadRoles(userId)
  const legacyIds = await db.select({
    source: schema.legacyIds.source,
    legacyId: schema.legacyIds.legacyId,
  }).from(schema.legacyIds).where(eq(schema.legacyIds.userId, userId)).all()

  const auditEntries = await db.select({
    action: schema.auditLog.action,
    detail: schema.auditLog.detail,
    createdAt: schema.auditLog.createdAt,
  }).from(schema.auditLog)
    .where(or(eq(schema.auditLog.target, userId), eq(schema.auditLog.actorUserId, userId)))
    .all()

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
      roles,
      legacyIds,
    },
    auditEntries,
    // Hooks answer { data: <app-held personal data> } — unwrap per contract.
    apps: Object.fromEntries(hooks.map(h => [h.app, h.ok ? h.data?.data : { error: `export unavailable: ${h.error}` }])),
  }
}
