/**
 * Test stand-in for the `@nuxthub/db` virtual module: the same Drizzle
 * schema, backed by in-memory better-sqlite3, with the real generated
 * migration applied so tests exercise the production DDL.
 */

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import * as userSchema from '../../server/db/schema/user'
import * as legacySchema from '../../server/db/schema/legacy'
import * as serviceSchema from '../../server/db/schema/service'
import * as auditSchema from '../../server/db/schema/audit'
import * as rateLimitSchema from '../../server/db/schema/rateLimit'
import * as retentionSchema from '../../server/db/schema/retention'
import * as mfaSchema from '../../server/db/schema/mfa'

export const schema = {
  ...userSchema,
  ...legacySchema,
  ...serviceSchema,
  ...auditSchema,
  ...rateLimitSchema,
  ...retentionSchema,
  ...mfaSchema,
}

const sqlite = new Database(':memory:')
sqlite.pragma('foreign_keys = ON')

const migrationsDir = join(__dirname, '../../server/db/migrations/sqlite')
for (const file of readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).sort()) {
  const migration = readFileSync(join(migrationsDir, file), 'utf8')
  for (const statement of migration.split('--> statement-breakpoint')) {
    if (statement.trim()) sqlite.exec(statement)
  }
}

export const db = drizzle(sqlite, { schema })

/** Wipe all rows between tests (schema stays). */
export function resetDb(): void {
  sqlite.exec(`
    DELETE FROM user_roles;
    DELETE FROM role_definitions;
    DELETE FROM email_verifications;
    DELETE FROM password_resets;
    DELETE FROM legacy_ids;
    DELETE FROM service_tokens;
    DELETE FROM audit_log;
    DELETE FROM rate_limits;
    DELETE FROM retention_notices;
    DELETE FROM webauthn_credentials;
    DELETE FROM totp_secrets;
    DELETE FROM mfa_recovery_codes;
    DELETE FROM mfa_challenges;
    DELETE FROM users;
  `)
}
