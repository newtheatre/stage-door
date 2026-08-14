import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core'
import { nanoid } from 'nanoid'

// Per-app bearer tokens. The plaintext is shown once at creation; only its
// SHA-256 is stored, and compared in constant time.
export const serviceTokens = sqliteTable('service_tokens', {
  id: text('id').primaryKey().$defaultFn(() => nanoid()),
  name: text('name').notNull().unique(), // e.g. 'proscenium'
  tokenHash: text('token_hash').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(() => new Date()),
  lastUsedAt: integer('last_used_at', { mode: 'timestamp_ms' }),
})
