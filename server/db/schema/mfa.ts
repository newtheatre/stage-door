import { sqliteTable, text, integer, index, uniqueIndex } from 'drizzle-orm/sqlite-core'
import { nanoid } from 'nanoid'
import { users } from './user'

/**
 * Second-factor credentials (ADR-0012). Both factor types are supported
 * deliberately: passkeys suit personal accounts, TOTP suits accounts whose
 * seed lives in the committee password manager and hands over annually.
 */

// Passkeys. Shape mirrors the WebAuthnCredential nuxt-auth-utils hands to
// onSuccess, so registration is a straight insert.
export const webauthnCredentials = sqliteTable('webauthn_credentials', {
  id: text('id').primaryKey().$defaultFn(() => nanoid()),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  credentialId: text('credential_id').notNull().unique(),
  publicKey: text('public_key').notNull(),
  counter: integer('counter').notNull().default(0),
  transports: text('transports'), // JSON array
  backedUp: integer('backed_up', { mode: 'boolean' }).notNull().default(false),
  name: text('name').notNull(), // user-facing label, e.g. "MacBook"
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(() => new Date()),
  lastUsedAt: integer('last_used_at', { mode: 'timestamp_ms' }),
}, table => [
  index('webauthn_credentials_user_id_idx').on(table.userId),
])

// TOTP. One secret per user; `confirmedAt` is null until they prove they
// can generate a code, so a half-finished enrolment never gates a login.
export const totpSecrets = sqliteTable('totp_secrets', {
  userId: text('user_id').primaryKey().references(() => users.id, { onDelete: 'cascade' }),
  secret: text('secret').notNull(), // base32
  confirmedAt: integer('confirmed_at', { mode: 'timestamp_ms' }),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(() => new Date()),
  // Highest time-step already accepted — blocks replay of a code inside its
  // own validity window.
  lastUsedStep: integer('last_used_step'),
})

// Recovery codes: SHA-256 at rest, plaintext shown once at generation
// (same treatment as service tokens).
export const mfaRecoveryCodes = sqliteTable('mfa_recovery_codes', {
  id: text('id').primaryKey().$defaultFn(() => nanoid()),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  codeHash: text('code_hash').notNull(),
  usedAt: integer('used_at', { mode: 'timestamp_ms' }),
}, table => [
  index('mfa_recovery_codes_user_id_idx').on(table.userId),
])

/**
 * Short-lived server state, used for two things:
 *
 * 1. WebAuthn challenges — nuxt-auth-utils' storeChallenge/getChallenge pair
 *    is all-or-nothing, and omitting it verifies against an empty challenge
 *    (i.e. no replay protection).
 * 2. Pending logins — the "password accepted, second factor outstanding"
 *    state. It lives here rather than in a cookie because a second sealed
 *    cookie inherits `cookie.domain` via defu and would broadcast a
 *    half-authenticated cookie across the whole estate.
 *
 * KV is disabled on this worker, so useStorage() would be per-isolate and
 * silently lose challenges between requests.
 */
export const mfaChallenges = sqliteTable('mfa_challenges', {
  id: text('id').primaryKey(), // opaque, high-entropy; handed to the client
  // Null only for a passkey *authentication* challenge: those are
  // usernameless (the credential in the response names the account), so
  // there is no user to attribute the challenge to when it is issued.
  userId: text('user_id').references(() => users.id, { onDelete: 'cascade' }),
  kind: text('kind', { enum: ['login', 'webauthn-register', 'webauthn-authenticate'] }).notNull(),
  challenge: text('challenge'), // WebAuthn challenge; null for plain login state
  expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
}, table => [
  index('mfa_challenges_user_id_idx').on(table.userId),
  index('mfa_challenges_expires_at_idx').on(table.expiresAt),
  uniqueIndex('mfa_challenges_id_unique').on(table.id),
])
