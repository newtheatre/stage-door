import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core'
import { nanoid } from 'nanoid'

/**
 * Estate apps this service knows about (ADR-0017). A row is what makes an app
 * real: hooks reach it, and from Phase 3 its manifest is polled.
 */
export const apps = sqliteTable('apps', {
  id: text('id').primaryKey().$defaultFn(() => nanoid()),
  // Joins service_tokens.name by string; both are unique.
  name: text('name').notNull().unique(),
  // rehearsal serves the `training` namespace: the two are not the same thing.
  namespace: text('namespace').notNull().unique(),
  displayName: text('display_name').notNull(),
  baseUrl: text('base_url').notNull(),
  // Off by default so a half-registered app cannot silently swallow an erasure.
  hooksEnabled: integer('hooks_enabled', { mode: 'boolean' }).notNull().default(false),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(() => new Date()),
}, table => [
  index('apps_namespace_idx').on(table.namespace),
])
