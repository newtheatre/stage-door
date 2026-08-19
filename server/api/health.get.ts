import { db } from '@nuxthub/db'
import { sql } from 'drizzle-orm'
import { version } from '../../package.json'
import journal from '../db/migrations/sqlite/meta/_journal.json'

/** GET /api/health — uptime check (docs/api-reference.md). */
export default defineEventHandler(async (event) => {
  const expected = journal.entries.map(entry => `${entry.tag}.sql`)
  let pending: string[] = []

  try {
    // Raw SQL on purpose: NuxtHub owns this table, so declaring it in the
    // Drizzle schema would make db:generate try to create it.
    const rows = await db.all<{ name: string }>(sql`select name from _hub_migrations`)
    const applied = new Set(rows.map(r => r.name))
    pending = expected.filter(name => !applied.has(name))
  }
  catch (error) {
    // The table itself is missing, so nothing has ever been applied here.
    console.error('[health] could not read _hub_migrations:', error)
    pending = expected
  }

  if (pending.length) {
    // The deployed code was built against a schema this database does not
    // have. Failing loudly is the signal that was missing (ADR-0021).
    setResponseStatus(event, 503)
    return { ok: false, version, pendingMigrations: pending }
  }

  return { ok: true, version }
})
