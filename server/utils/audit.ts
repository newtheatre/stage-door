import { db, schema } from '@nuxthub/db'
import { and, eq, isNotNull } from 'drizzle-orm'

/**
 * Append to the audit log. Failures are logged but never break the action
 * being audited.
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

const REDACTED = '[redacted]'

/** Addresses anywhere, and any `name`: what re-identifies an anonymised row. */
function redactValues(key: string, value: unknown): unknown {
  if (typeof value === 'string') return value.includes('@') || key === 'name' ? REDACTED : value
  if (Array.isArray(value)) return value.map(item => redactValues(key, item))
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactValues(k, v)]))
  }
  return value
}

/** How many rewrites go in one batch. Each binds two parameters (D1 caps at 100). */
const REDACT_CHUNK = 20

/**
 * The one write that is not an append: erasure rewrites identifying values in
 * rows about this user (ADR-0026). Idempotent, so a re-driven erasure is safe.
 */
export async function redactAuditDetail(userId: string): Promise<void> {
  const rows = await db.select({ id: schema.auditLog.id, detail: schema.auditLog.detail })
    .from(schema.auditLog)
    .where(and(eq(schema.auditLog.target, userId), isNotNull(schema.auditLog.detail)))
    .all()

  const changed: { id: string, detail: string }[] = []
  for (const row of rows) {
    let parsed: unknown
    try {
      parsed = JSON.parse(row.detail!)
    }
    catch {
      // Not JSON, so nothing structured to redact; leave the row alone.
      continue
    }
    const detail = JSON.stringify(redactValues('', parsed))
    if (detail !== row.detail) changed.push({ id: row.id, detail })
  }

  for (let i = 0; i < changed.length; i += REDACT_CHUNK) {
    const [first, ...rest] = changed.slice(i, i + REDACT_CHUNK)
      .map(row => db.update(schema.auditLog).set({ detail: row.detail }).where(eq(schema.auditLog.id, row.id)))
    if (first) await db.batch([first, ...rest])
  }
}
