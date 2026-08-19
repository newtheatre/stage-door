import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core'
import { nanoid } from 'nanoid'
import { apps } from './apps'

// Per-app bearer tokens. The plaintext is shown once at creation; only its
// SHA-256 is stored, and compared in constant time.
export const serviceTokens = sqliteTable('service_tokens', {
  id: text('id').primaryKey().$defaultFn(() => nanoid()),
  // Not unique: overlap rotation issues the new token before revoking the
  // old, so an app briefly has two. hookBearer sends the newest.
  name: text('name').notNull(), // e.g. 'proscenium'
  // No ON DELETE: SQLite cannot add one to an existing table, so deleting an
  // app clears its tokens' app_id in the handler (ADR-0017).
  appId: text('app_id').references(() => apps.id),
  tokenHash: text('token_hash').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(() => new Date()),
  lastUsedAt: integer('last_used_at', { mode: 'timestamp_ms' }),
}, table => [
  index('service_tokens_name_idx').on(table.name),
])
