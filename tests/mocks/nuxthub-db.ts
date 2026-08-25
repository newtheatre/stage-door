/**
 * Stand-in for the `@nuxthub/db` virtual module: the same schema on in-memory
 * sqlite, with the real migration applied. bun:sqlite needs no native build.
 */

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import * as userSchema from '../../server/db/schema/user'
import * as legacySchema from '../../server/db/schema/legacy'
import * as serviceSchema from '../../server/db/schema/service'
import * as auditSchema from '../../server/db/schema/audit'
import * as rateLimitSchema from '../../server/db/schema/rateLimit'
import * as retentionSchema from '../../server/db/schema/retention'
import * as mfaSchema from '../../server/db/schema/mfa'
import * as appsSchema from '../../server/db/schema/apps'

export const schema = {
  ...userSchema,
  ...legacySchema,
  ...serviceSchema,
  ...auditSchema,
  ...rateLimitSchema,
  ...retentionSchema,
  ...mfaSchema,
  ...appsSchema,
}

const sqlite = new Database(':memory:')
sqlite.exec('PRAGMA foreign_keys = ON')

const migrationsDir = join(__dirname, '../../server/db/migrations/sqlite')
for (const file of readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).sort()) {
  const migration = readFileSync(join(migrationsDir, file), 'utf8')
  for (const statement of migration.split('--> statement-breakpoint')) {
    if (statement.trim()) sqlite.exec(statement)
  }
}

type Statement = { execute: () => unknown }

export const db = drizzle(sqlite, { schema })

/**
 * D1 runs a batch in order inside one transaction and returns each result. The
 * bun-sqlite driver has no batch, and a delete's execute() settles late.
 */
async function runBatch(statements: Statement[]): Promise<unknown[]> {
  sqlite.exec('BEGIN')
  try {
    const results: unknown[] = []
    for (const statement of statements) results.push(await statement.execute())
    sqlite.exec('COMMIT')
    return results
  }
  catch (error) {
    sqlite.exec('ROLLBACK')
    throw error
  }
}
Object.assign(db, { batch: runBatch })

/** Wipe all rows between tests (schema stays). */
export function resetDb(): void {
  sqlite.exec(`
    DELETE FROM user_roles;
    DELETE FROM role_definitions;
    DELETE FROM email_verifications;
    DELETE FROM password_resets;
    DELETE FROM legacy_ids;
    DELETE FROM service_tokens;
    DELETE FROM role_definition_permissions;
    DELETE FROM app_permissions;
    DELETE FROM app_manifests;
    DELETE FROM eligibility_snapshots;
    DELETE FROM eligibility_syncs;
    DELETE FROM apps;
    DELETE FROM audit_log;
    DELETE FROM rate_limits;
    DELETE FROM retention_notices;
    DELETE FROM webauthn_credentials;
    DELETE FROM totp_secrets;
    DELETE FROM mfa_recovery_codes;
    DELETE FROM mfa_challenges;
    DELETE FROM magic_links;
    DELETE FROM users;
  `)
}
