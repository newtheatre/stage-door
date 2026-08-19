/**
 * Verification gate (docs/migration.md#verification-gate): asserts, not
 * eyeballs. Exits non-zero on any failure. `--remote` checks production.
 */

import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { execSync } from 'node:child_process'
import { Database } from 'bun:sqlite'

const ROOT = join(import.meta.dirname, '../..')
const DATA = join(ROOT, '.data/migrate')
const remote = process.argv.includes('--remote')

const SEED_EMAILS = [
  'admin@newtheatre.org.uk', 'manager@newtheatre.org.uk', 'boxoffice@newtheatre.org.uk',
  'user@newtheatre.org.uk', 'unverified@newtheatre.org.uk',
]

// Mirrors build.ts: passworded accounts on undeliverable domains.
function isUndeliverableTestAccount(email: string, password: string | null): boolean {
  if (password === null) return false
  return /@example\.(com|org|net)$|\.invalid$|\.test$|\.example$/.test(email)
}

// ── Target access (local rehearsal file, or remote via wrangler) ────────────

type Row = Record<string, unknown>
let queryTarget: (sql: string) => Row[]

if (remote) {
  queryTarget = (sql: string) => {
    // Wrangler rejects literal newlines in --command; collapse whitespace.
    const flat = sql.replace(/\s+/g, ' ').trim()
    const out = execSync(
      `npx wrangler d1 execute auth --remote --json --command ${JSON.stringify(flat)}`,
      { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    )
    return JSON.parse(out)[0].results as Row[]
  }
}
else {
  const file = join(DATA, 'out/rehearsal-auth.sqlite')
  if (!existsSync(file)) {
    console.error(`No rehearsal DB at ${file}: run scripts/migrate/rehearse.sh first.`)
    process.exit(1)
  }
  const db = new Database(file, { readonly: true })
  queryTarget = (sql: string) => db.prepare(sql).all() as Row[]
}

function loadSource(name: string): Database {
  const db = new Database(':memory:')
  // Same sqlite_sequence filtering as build.ts's loadDump: see comment there.
  const sql = readFileSync(join(DATA, `${name}.sql`), 'utf8')
    .split('\n')
    .filter(line => !line.includes('sqlite_sequence'))
    .join('\n')
  db.exec(sql)
  return db
}

const pros = loadSource('proscenium')
const rooms = loadSource('rooms')

const preLegacyIds = new Set<string>(
  JSON.parse(readFileSync(join(DATA, 'pre-legacy-proscenium-ids.json'), 'utf8')) as string[],
)

/** Every email neutralised by the build: seeds + undeliverable test accounts. */
const neutralisedEmails = new Set<string>(SEED_EMAILS.filter(e =>
  (pros.prepare('SELECT count(*) n FROM users WHERE lower(email)=?').get(e) as { n: number }).n > 0))
for (const row of pros.prepare('SELECT lower(email) email, password FROM users WHERE password IS NOT NULL').all() as { email: string, password: string }[]) {
  if (isUndeliverableTestAccount(row.email, row.password)) neutralisedEmails.add(row.email)
}

// ── Assertions ──────────────────────────────────────────────────────────────

let failures = 0
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) {
    console.info(`  ✓ ${label}`)
  }
  else {
    failures += 1
    console.error(`  ✗ ${label}${detail !== undefined ? `: ${JSON.stringify(detail)}` : ''}`)
  }
}

const one = (sql: string) => queryTarget(sql)[0] as { n: number }

console.info('Verification gate:')

// 1. Distinct lowercased emails across sources == users count (seeds kept, neutralised).
const prosEmails = (pros.prepare('SELECT lower(email) e FROM users').all() as { e: string }[]).map(r => r.e)
const roomsEmails = (rooms.prepare('SELECT lower(email) e FROM users').all() as { e: string }[]).map(r => r.e)
const distinctEmails = new Set([...prosEmails, ...roomsEmails])
const userCount = one('SELECT count(*) n FROM users').n
// Accounts created directly on the auth service are not source rows; count
// them separately and surface them.
const targetEmails = (queryTarget('SELECT email FROM users') as { email: string }[]).map(r => r.email)
const extras = targetEmails.filter(e => !distinctEmails.has(e))
if (extras.length) console.info(`  ℹ ${extras.length} pre-existing non-source account(s): ${extras.join(', ')}`)
check(`users count ${userCount} == distinct source emails ${distinctEmails.size} + ${extras.length} pre-existing`,
  userCount === distinctEmails.size + extras.length)

// 2. legacy_ids: one row per source row.
const expectedLegacy = prosEmails.length + roomsEmails.length
const legacyCount = one('SELECT count(*) n FROM legacy_ids').n
check(`legacy_ids ${legacyCount} == source rows ${expectedLegacy}`, legacyCount === expectedLegacy)
check('every proscenium id has a legacy entry',
  one(`SELECT count(*) n FROM legacy_ids WHERE source='proscenium'`).n === prosEmails.length)
check('every rooms id has a legacy entry',
  one(`SELECT count(*) n FROM legacy_ids WHERE source='rooms'`).n === roomsEmails.length)

// 3. FK integrity: every reservation/booking owner exists in the merged users.
const targetIds = new Set((queryTarget('SELECT id FROM users') as { id: string }[]).map(r => r.id))

// Reservations after the case-duplicate fold: apply proscenium-fixes to a
// copy and check every owner resolves.
function tableExists(handle: ReturnType<typeof loadSource>, table: string): boolean {
  return Boolean(handle.prepare('SELECT name FROM sqlite_master WHERE type = ? AND name = ?').get('table', table))
}

const prosCopy = loadSource('proscenium')
const prosFixesFile = join(DATA, 'out/proscenium-fixes.sql')
if (existsSync(prosFixesFile)) {
  prosCopy.exec(readFileSync(prosFixesFile, 'utf8'))
}
const reservationOwners = (prosCopy.prepare('SELECT DISTINCT user_id FROM reservations').all() as { user_id: string }[]).map(r => r.user_id)
check(`all ${reservationOwners.length} reservation owners resolve post-fold`,
  reservationOwners.every(id => targetIds.has(id)))
check('no reservations lost by the fold',
  (prosCopy.prepare('SELECT count(*) n FROM reservations').get() as { n: number }).n
  === (pros.prepare('SELECT count(*) n FROM reservations').get() as { n: number }).n)

// Two of these are restrict (a missed one aborts the DELETE) and two are
// set null (the attribution is erased silently).
for (const [table, column] of [
  ['passes', 'user_id'],
  ['passes', 'issued_by_user_id'],
  ['pass_admissions', 'redeemed_by_user_id'],
] as const) {
  if (!tableExists(prosCopy, table)) continue

  const orphans = prosCopy
    .prepare(`SELECT DISTINCT ${column} AS id FROM ${table} WHERE ${column} IS NOT NULL`)
    .all() as { id: string }[]
  check(`all ${table}.${column} values resolve post-fold`,
    orphans.every(r => targetIds.has(r.id)))

  const before = (pros.prepare(`SELECT count(*) n FROM ${table} WHERE ${column} IS NOT NULL`).get() as { n: number }).n
  const after = (prosCopy.prepare(`SELECT count(*) n FROM ${table} WHERE ${column} IS NOT NULL`).get() as { n: number }).n
  check(`no ${table}.${column} attribution lost by the fold`, before === after)
}

// Bookings after the re-point: apply rooms-fixes to a copy and check.
const roomsCopy = loadSource('rooms')
const fixesFile = join(DATA, 'out/rooms-fixes.sql')
if (existsSync(fixesFile)) {
  // The generated file only contains UPDATEs on bookings/push_subscriptions.
  // FK enforcement is off in this scratch copy, so order doesn't matter.
  roomsCopy.exec(readFileSync(fixesFile, 'utf8'))
}
const bookingOwners = (roomsCopy.prepare('SELECT DISTINCT user_id FROM bookings WHERE user_id IS NOT NULL').all() as { user_id: string }[]).map(r => r.user_id)
check(`all ${bookingOwners.length} booking owners resolve post-fix`,
  bookingOwners.every(id => targetIds.has(id)))
const pushOwners = (roomsCopy.prepare('SELECT DISTINCT user_id FROM push_subscriptions').all() as { user_id: string }[]).map(r => r.user_id)
check(`all ${pushOwners.length} push-subscription owners resolve post-fix`,
  pushOwners.every(id => targetIds.has(id)))

// 4. Hashes byte-identical (Proscenium-wins rule), and PHC format everywhere.
const targetByEmail = new Map(
  (queryTarget('SELECT email, password FROM users') as { email: string, password: string | null }[]).map(r => [r.email, r.password]),
)
let hashChecked = 0
let hashOk = true
// Per-email expected hash mirrors the build's fold rule: rows sorted by
// created_at, first non-null password wins.
const prosPwByEmail = new Map<string, string>()
for (const p of pros.prepare('SELECT lower(email) email, password FROM users WHERE password IS NOT NULL ORDER BY created_at').all() as { email: string, password: string }[]) {
  if (!prosPwByEmail.has(p.email)) prosPwByEmail.set(p.email, p.password)
}
for (const [email, password] of prosPwByEmail) {
  if (neutralisedEmails.has(email)) continue
  hashChecked += 1
  if (targetByEmail.get(email) !== password) hashOk = false
}
for (const r of rooms.prepare('SELECT lower(email) email, password_hash FROM users').all() as { email: string, password_hash: string }[]) {
  const inPros = prosEmails.includes(r.email)
  const prosHasPw = inPros && !!(pros.prepare('SELECT password FROM users WHERE lower(email)=?').get(r.email) as { password: string | null }).password
  if (SEED_EMAILS.includes(r.email) || prosHasPw) continue
  hashChecked += 1
  if (targetByEmail.get(r.email) !== r.password_hash) hashOk = false
}
check(`${hashChecked} password hashes byte-identical to source`, hashOk)
check('all stored hashes are scrypt PHC strings',
  one(`SELECT count(*) n FROM users WHERE password IS NOT NULL AND password NOT LIKE '$scrypt$%'`).n === 0)

// Role counts per namespace: see docs/migration.md for the expected split.
const sourceRoles = pros.prepare(`
  SELECT ur.role, u.id, lower(u.email) email FROM user_roles ur JOIN users u ON u.id = ur.user_id
`).all() as { role: string, id: string, email: string }[]
const expectedPros = sourceRoles.filter(r => preLegacyIds.has(r.id) && !neutralisedEmails.has(r.email)).length
const expectedTicketing = sourceRoles.filter(r => !preLegacyIds.has(r.id) && !neutralisedEmails.has(r.email)).length
const carried = one(`SELECT count(*) n FROM user_roles WHERE role LIKE 'proscenium:%'`).n
const ticketing = one(`SELECT count(*) n FROM user_roles WHERE role LIKE 'ticketing:%'`).n
check(`proscenium:* roles ${carried} == carried ${expectedPros} + 1 explicit ADMIN grant`, carried === expectedPros + 1)
check(`ticketing:* roles ${ticketing} == legacy-import holders' ${expectedTicketing} (dormant namespace)`, ticketing === expectedTicketing)

const roomsAdmins = (rooms.prepare(`SELECT count(*) n FROM users WHERE role='ADMIN'`).get() as { n: number }).n
check(`rooms:ADMIN count == ${roomsAdmins}`,
  one(`SELECT count(*) n FROM user_roles WHERE role='rooms:ADMIN'`).n === roomsAdmins)
check('exactly one auth:ADMIN (the ITM)',
  one(`SELECT count(*) n FROM user_roles WHERE role='auth:ADMIN'`).n === 1)

// 6. Neutralised accounts (seeds + undeliverable test accounts): kept, harmless.
for (const email of neutralisedEmails) {
  const [row] = queryTarget(`SELECT password, disabled, email_verified,
    (SELECT count(*) FROM user_roles WHERE user_id = users.id) roles
    FROM users WHERE email = '${email}'`) as { password: string | null, disabled: number, roles: number }[]
  check(`${email} neutralised (no password, disabled, no roles)`,
    !!row && row.password === null && row.disabled === 1 && row.roles === 0)
}

// 7. Merged users: canonical id is the Proscenium id.
const bothEmails = prosEmails.filter(e => roomsEmails.includes(e))
let idsOk = true
for (const email of bothEmails) {
  const prosId = (pros.prepare('SELECT id FROM users WHERE lower(email)=?').get(email) as { id: string }).id
  const [target] = queryTarget(`SELECT id FROM users WHERE email = '${email}'`) as { id: string }[]
  if (!target || target.id !== prosId) idsOk = false
}
check(`${bothEmails.length} in-both users kept the Proscenium id`, idsOk)

// ── Result ──────────────────────────────────────────────────────────────────

if (failures) {
  console.error(`\nGATE FAILED: ${failures} assertion(s). Do not proceed.`)
  process.exit(1)
}
console.info(`\nGate passed${remote ? ' against PRODUCTION' : ' (rehearsal)'}.`)
console.info('Remaining manual step: the ITM logs in against the merged DB with their old password (docs/migration.md).')
