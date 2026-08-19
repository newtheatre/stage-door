/**
 * Apply pending D1 migrations to a deployed environment (ADR-0021).
 * Usage: node scripts/migrate-remote.mjs [--database auth] [--dry-run]
 */

import { execFileSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'

const args = process.argv.slice(2)
const database = valueOf('--database') ?? 'auth'
const dryRun = args.includes('--dry-run')
const MIGRATIONS_DIR = 'server/db/migrations/sqlite'

function valueOf(flag) {
  const i = args.indexOf(flag)
  return i === -1 ? undefined : args[i + 1]
}

function wrangler(extra) {
  const out = execFileSync('npx', ['wrangler@4', 'd1', 'execute', database, '--remote', '--json', ...extra], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
    env: process.env,
  })
  // wrangler prints a banner before the JSON on some versions.
  return JSON.parse(out.slice(out.indexOf('[')))
}

function applied() {
  try {
    return new Set(wrangler(['--command', 'select name from _hub_migrations'])[0].results.map(r => r.name))
  }
  catch {
    // First deploy of a fresh database: the table arrives with migration 0000.
    console.log('No _hub_migrations table yet — treating every migration as pending.')
    return new Set()
  }
}

const done = applied()
const pending = readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.sql') && !done.has(f)).sort()

if (!pending.length) {
  console.log(`${database}: up to date (${done.size} applied).`)
  process.exit(0)
}

console.log(`${database}: ${pending.length} pending — ${pending.join(', ')}`)
if (dryRun) process.exit(0)

for (const file of pending) {
  process.stdout.write(`  ${file} … `)
  wrangler(['--file', join(MIGRATIONS_DIR, file)])
  // Recorded only after the file succeeds, so a failure leaves it pending.
  wrangler(['--command', `insert into _hub_migrations (name) values ('${file.replace(/'/g, '\'\'')}')`])
  console.log('applied')
}

console.log(`${database}: ${pending.length} applied.`)
