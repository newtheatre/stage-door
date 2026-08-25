import { sqliteTable, text, integer, index, uniqueIndex } from 'drizzle-orm/sqlite-core'
import { relations, sql } from 'drizzle-orm'
import { nanoid } from 'nanoid'

// Canonical identity store: docs/data-model.md. Ids are stable forever
// (CLAUDE.md invariant 3): apps FK against them.
export const users = sqliteTable('users', {
  id: text('id').primaryKey().$defaultFn(() => nanoid()),
  email: text('email').notNull().unique(), // stored lowercased, always
  name: text('name').notNull(),
  password: text('password'), // scrypt PHC string; NULL = shadow account or SSO-only
  verified: integer('email_verified', { mode: 'boolean' }).notNull().default(false),

  // Google's stable subject id: the linkage key, not email (ADR-0005). May
  // carry a different address from `email`; that's a supported steady state.
  googleSub: text('google_sub').unique(),
  // Admin-set: the next Google sign-in with this Workspace address attaches to
  // this account instead of creating a new one. Cleared on consumption.
  pendingGoogleEmail: text('pending_google_email'),

  // Disabled users fail login and fail /api/session/refresh.
  disabled: integer('disabled', { mode: 'boolean' }).notNull().default(false),
  // Bump to invalidate this user's sessions at next refresh (force-logout).
  sessionEpoch: integer('session_epoch').notNull().default(0),

  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(() => new Date()),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(() => new Date()).$onUpdateFn(() => new Date()),
  // Updated on successful login/SSO only, not refresh.
  lastLogin: integer('last_login', { mode: 'timestamp_ms' }),
}, table => [
  index('users_email_idx').on(table.email),
])

export const usersRelations = relations(users, ({ many }) => ({
  userRoles: many(userRoles),
  emailVerifications: many(emailVerifications),
  passwordResets: many(passwordResets),
  magicLinks: many(magicLinks),
}))

// Scoped role strings, expiry enforced at READ time: an expired grant
// vanishes within the staleness window with no cron. ADR-0004, ADR-0011.
export const userRoles = sqliteTable('user_roles', {
  id: text('id').primaryKey().$defaultFn(() => nanoid()),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  role: text('role').notNull(),

  // NULL = permanent grant.
  expiresAt: integer('expires_at', { mode: 'timestamp_ms' }),
  // Grant provenance. Plain text ids (no FK) matching audit_log's actor
  // pattern; NULL = pre-v2 grant or system action.
  grantedBy: text('granted_by'),
  grantedAt: integer('granted_at', { mode: 'timestamp_ms' }).$defaultFn(() => new Date()),
  note: text('note'),
  // Warning bookkeeping: one warning per (grant, expiry value): cleared by
  // roles.put whenever expires_at changes, so renewals re-arm the warning.
  expiryWarnedAt: integer('expiry_warned_at', { mode: 'timestamp_ms' }),
  // Admin escape hatch when an enforcing prerequisite is unmet or its snapshot
  // is wrong. Audited, and it lapses on its own (ADR-0019).
  eligibilityOverrideUntil: integer('eligibility_override_until', { mode: 'timestamp_ms' }),
}, table => [
  index('user_roles_user_id_idx').on(table.userId),
  index('user_roles_role_idx').on(table.role),
  uniqueIndex('user_roles_user_id_role_unique').on(table.userId, table.role),
])

// What a role is (ADR-0011/0014/0018). A new grant requires a definition;
// deleting one still never touches existing grants.
export const roleDefinitions = sqliteTable('role_definitions', {
  id: text('id').primaryKey().$defaultFn(() => nanoid()),
  namespace: text('namespace').notNull(), // 'proscenium'
  role: text('role').notNull(), // 'BOX_OFFICE'
  description: text('description').notNull(),
  defaultExpiryKind: text('default_expiry_kind', { enum: ['none', 'committee-year', 'days'] }).notNull().default('none'),
  defaultExpiryDays: integer('default_expiry_days'), // only when kind = 'days'
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(() => new Date()),

  // Manifest provenance (ADR-0018, ADR-0024). 'manual' with a null app_id is
  // now only the frozen `ticketing:*` history: nothing can create one.
  appId: text('app_id'),
  source: text('source', { enum: ['manifest', 'manual'] }).notNull().default('manual'),
  manifestVersion: text('manifest_version'),
  // Set when the owning manifest stops declaring the role. Grants are untouched.
  withdrawnAt: integer('withdrawn_at', { mode: 'timestamp_ms' }),
  syncedAt: integer('synced_at', { mode: 'timestamp_ms' }),

  // A training prerequisite, named by the app but enforced at this service's
  // discretion (ADR-0019). Inert until Phase 5 sets a key.
  requiresEligibilityKey: text('requires_eligibility_key'),
  eligibilityMode: text('eligibility_mode', { enum: ['advisory', 'enforcing'] }).notNull().default('advisory'),

  // The joined form user_roles.role stores, so a grant can be matched to its
  // definition inside SQL rather than by concatenating in JavaScript.
  roleKey: text('role_key').generatedAlwaysAs(sql`${sql.identifier('namespace')} || ':' || ${sql.identifier('role')}`, { mode: 'virtual' }),
}, table => [
  uniqueIndex('role_definitions_namespace_role_unique').on(table.namespace, table.role),
  index('role_definitions_role_key_idx').on(table.roleKey),
  index('role_definitions_app_id_idx').on(table.appId),
])

export const userRolesRelations = relations(userRoles, ({ one }) => ({
  user: one(users, {
    fields: [userRoles.userId],
    references: [users.id],
  }),
}))

// Verification tokens live 24h; single-use; issuing a new one deletes
// outstanding ones for that user. `email` is the address it proves, not the row.
export const emailVerifications = sqliteTable('email_verifications', {
  id: text('id').primaryKey().$defaultFn(() => nanoid()),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  // Nullable only for rows minted before the column existed; those verify nothing.
  email: text('email'),
  token: text('token').notNull().unique(),
  expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(() => new Date()),
}, table => [
  index('email_verifications_user_id_idx').on(table.userId),
])

export const emailVerificationsRelations = relations(emailVerifications, ({ one }) => ({
  user: one(users, {
    fields: [emailVerifications.userId],
    references: [users.id],
  }),
}))

// Reset tokens live 1h (self-service) or 24h (admin-initiated); single-use;
// issuing a new one deletes outstanding ones for that user.
export const passwordResets = sqliteTable('password_resets', {
  id: text('id').primaryKey().$defaultFn(() => nanoid()),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  token: text('token').notNull().unique(),
  expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(() => new Date()),
}, table => [
  index('password_resets_user_id_idx').on(table.userId),
])

export const passwordResetsRelations = relations(passwordResets, ({ one }) => ({
  user: one(users, {
    fields: [passwordResets.userId],
    references: [users.id],
  }),
}))

// Magic sign-in links (ADR-0013). Hashed at rest: a link grants an instant
// session, so it gets the service-token treatment.
export const magicLinks = sqliteTable('magic_links', {
  id: text('id').primaryKey().$defaultFn(() => nanoid()),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  tokenHash: text('token_hash').notNull().unique(),
  expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(() => new Date()),
}, table => [
  index('magic_links_user_id_idx').on(table.userId),
])

export const magicLinksRelations = relations(magicLinks, ({ one }) => ({
  user: one(users, {
    fields: [magicLinks.userId],
    references: [users.id],
  }),
}))
