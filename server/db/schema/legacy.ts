import { sqliteTable, text, index, uniqueIndex } from 'drizzle-orm/sqlite-core'
import { nanoid } from 'nanoid'
import { users } from './user'

// Written for every user migrated from Proscenium/rooms, even where ids were
// preserved. Read-only after migration; kept forever (docs/migration.md).
export const legacyIds = sqliteTable('legacy_ids', {
  id: text('id').primaryKey().$defaultFn(() => nanoid()),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  // 'merge' rows are markers, not imports: legacyId holds the erased
  // account's users.id so a merged-away identity stays findable (ADR-0015).
  source: text('source', { enum: ['proscenium', 'rooms', 'merge'] }).notNull(),
  legacyId: text('legacy_id').notNull(),
}, table => [
  index('legacy_ids_user_id_idx').on(table.userId),
  uniqueIndex('legacy_ids_source_legacy_id_unique').on(table.source, table.legacyId),
])
