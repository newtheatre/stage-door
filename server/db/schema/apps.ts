import { sqliteTable, text, integer, index, uniqueIndex, primaryKey } from 'drizzle-orm/sqlite-core'
import { nanoid } from 'nanoid'
import { roleDefinitions } from './user'

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
  // Off by default: an app is polled only once someone has confirmed its
  // manifest is the one they meant to adopt (ADR-0018).
  manifestEnabled: integer('manifest_enabled', { mode: 'boolean' }).notNull().default(false),
  lastSyncedAt: integer('last_synced_at', { mode: 'timestamp_ms' }),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(() => new Date()),
}, table => [
  index('apps_namespace_idx').on(table.namespace),
])

/**
 * The last manifest each app served. A failed fetch or a rejected document
 * writes only the error fields, so the good copy is never lost (ADR-0018).
 */
export const appManifests = sqliteTable('app_manifests', {
  appId: text('app_id').primaryKey().references(() => apps.id, { onDelete: 'cascade' }),
  document: text('document').notNull(),
  // sha256 of the body; equal means the reconcile can be skipped entirely.
  documentHash: text('document_hash').notNull(),
  version: text('version').notNull(),
  etag: text('etag'),
  fetchedAt: integer('fetched_at', { mode: 'timestamp_ms' }).notNull(),
  appliedAt: integer('applied_at', { mode: 'timestamp_ms' }),
  lastAttemptAt: integer('last_attempt_at', { mode: 'timestamp_ms' }),
  // Non-null means the stored document is stale but still authoritative.
  lastError: text('last_error'),
})

/**
 * The permission vocabulary an app declares. Rows are deactivated rather than
 * deleted: audit detail and role links point at them.
 */
export const appPermissions = sqliteTable('app_permissions', {
  id: text('id').primaryKey().$defaultFn(() => nanoid()),
  appId: text('app_id').notNull().references(() => apps.id, { onDelete: 'cascade' }),
  namespace: text('namespace').notNull(),
  key: text('key').notNull(), // unqualified, e.g. 'money.refund'
  description: text('description').notNull(),
  active: integer('active', { mode: 'boolean' }).notNull().default(true),
  firstSeenAt: integer('first_seen_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(() => new Date()),
  lastSeenAt: integer('last_seen_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(() => new Date()),
}, table => [
  uniqueIndex('app_permissions_namespace_key_unique').on(table.namespace, table.key),
])

/** Which permissions a role definition carries. Answers "who can do X" in one join. */
export const roleDefinitionPermissions = sqliteTable('role_definition_permissions', {
  roleDefinitionId: text('role_definition_id').notNull().references(() => roleDefinitions.id, { onDelete: 'cascade' }),
  permissionId: text('permission_id').notNull().references(() => appPermissions.id, { onDelete: 'cascade' }),
}, table => [
  primaryKey({ columns: [table.roleDefinitionId, table.permissionId] }),
  index('role_definition_permissions_permission_idx').on(table.permissionId),
])
