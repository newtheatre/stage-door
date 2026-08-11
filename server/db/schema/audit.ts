import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core'
import { nanoid } from 'nanoid'

// Append-only. Written by admin actions, role changes, force-logouts,
// disable/enable, erasure, retention sweep, service-token issuance.
// NOT written by ordinary logins — that's users.last_login.
export const auditLog = sqliteTable('audit_log', {
  id: text('id').primaryKey().$defaultFn(() => nanoid()),
  actorUserId: text('actor_user_id'), // null = system/cron
  action: text('action').notNull(),
  target: text('target').notNull(),
  detail: text('detail'), // JSON
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(() => new Date()),
}, table => [
  index('audit_log_actor_idx').on(table.actorUserId),
  index('audit_log_action_idx').on(table.action),
  index('audit_log_created_at_idx').on(table.createdAt),
])
