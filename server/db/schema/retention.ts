import { sqliteTable, text, integer, index, uniqueIndex } from 'drizzle-orm/sqlite-core'
import { nanoid } from 'nanoid'
import { users } from './user'

// Warning-email bookkeeping for the inactive-account sweep
// (docs/gdpr-retention.md#inactive-account-retention-sweep). One row per
// warning stage actually sent; rows for a user are cleared when they log in
// again (the login resets their clock) and cascade away on erasure.
export const retentionNotices = sqliteTable('retention_notices', {
  id: text('id').primaryKey().$defaultFn(() => nanoid()),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  stage: text('stage', { enum: ['warning-60d', 'warning-30d'] }).notNull(),
  sentAt: integer('sent_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(() => new Date()),
}, table => [
  index('retention_notices_user_id_idx').on(table.userId),
  uniqueIndex('retention_notices_user_stage_unique').on(table.userId, table.stage),
])
