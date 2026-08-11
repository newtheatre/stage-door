import { db, schema } from '@nuxthub/db'

/**
 * Append to the audit log (docs/data-model.md#audit_log).
 *
 * Written by admin actions, role changes, force-logouts, disable/enable,
 * erasure, sweep actions, and service-token issuance — not ordinary logins.
 * Failures are logged but never break the action being audited.
 */
export async function writeAudit(entry: {
  actorUserId: string | null
  action: string
  target: string
  detail?: Record<string, unknown>
}): Promise<void> {
  try {
    await db.insert(schema.auditLog).values({
      actorUserId: entry.actorUserId,
      action: entry.action,
      target: entry.target,
      detail: entry.detail ? JSON.stringify(entry.detail) : null,
    })
  }
  catch (error) {
    console.error('[Audit] Failed to write audit log entry:', entry.action, error)
  }
}
