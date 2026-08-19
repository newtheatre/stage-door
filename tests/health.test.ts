/**
 * The health check exists to make a missing migration loud. It was silent
 * when live code met a schema six migrations behind (ADR-0021).
 */

import { describe, expect, it } from 'vitest'
import { db } from '@nuxthub/db'
import { sql } from 'drizzle-orm'
import healthHandler from '../server/api/health.get'
import journal from '../server/db/migrations/sqlite/meta/_journal.json'
import { makeEvent } from './setup'

interface Health { ok: boolean, version: string, pendingMigrations?: string[] }
const health = healthHandler as unknown as (event: unknown) => Promise<Health>

const ALL = journal.entries.map(e => e.tag)

function ledger(applied: string[]) {
  db.run(sql`create table if not exists _hub_migrations (id integer primary key autoincrement, name text unique, applied_at text default '')`)
  db.run(sql`delete from _hub_migrations`)
  for (const name of applied) db.run(sql`insert into _hub_migrations (name) values (${name})`)
}

describe('GET /api/health', () => {
  it('is ok when every migration in the journal has been applied', async () => {
    ledger(ALL)

    const result = await health(makeEvent({ method: 'GET', path: '/api/health' }))

    expect(result.ok).toBe(true)
    expect(result.pendingMigrations).toBeUndefined()
  })

  it('reports unhealthy and names what is missing when the schema is behind', async () => {
    // Exactly the production state during the outage: stopped at 0004.
    ledger(ALL.slice(0, 5))

    const result = await health(makeEvent({ method: 'GET', path: '/api/health' }))

    expect(result.ok).toBe(false)
    expect(result.pendingMigrations).toEqual(ALL.slice(5))
  })

  it('accepts either ledger spelling, since production carries both', async () => {
    // nuxt-db migrate records the bare tag; wrangler records it with .sql.
    ledger(ALL.map((tag, i) => (i % 2 ? `${tag}.sql` : tag)))

    expect((await health(makeEvent({ method: 'GET', path: '/api/health' }))).ok).toBe(true)
  })

  it('treats a missing ledger as nothing applied rather than throwing', async () => {
    db.run(sql`drop table if exists _hub_migrations`)

    const result = await health(makeEvent({ method: 'GET', path: '/api/health' }))

    expect(result.ok).toBe(false)
    expect(result.pendingMigrations).toEqual(ALL)
  })
})
