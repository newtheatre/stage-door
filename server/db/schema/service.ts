import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core'
import { nanoid } from 'nanoid'

// Per-app bearer tokens for server-to-server calls (shadow users, app hooks).
// Plaintext token (`nnt_svc_` + 32 random bytes base64url) is shown once at
// creation; only its SHA-256 is stored. Compared in constant time.
export const serviceTokens = sqliteTable('service_tokens', {
  id: text('id').primaryKey().$defaultFn(() => nanoid()),
  name: text('name').notNull().unique(), // e.g. 'proscenium'
  tokenHash: text('token_hash').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(() => new Date()),
  lastUsedAt: integer('last_used_at', { mode: 'timestamp_ms' }),
})
