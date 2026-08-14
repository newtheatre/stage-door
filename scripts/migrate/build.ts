/**
 * Build the merged user dataset from the exported source databases.
 * Deterministic. Inputs, outputs and rules: docs/migration.md
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'

const ROOT = join(import.meta.dirname, '../..')
const DATA = join(ROOT, '.data/migrate')
const OUT = join(DATA, 'out')

// ── Configuration (docs/migration.md rules 4–5) ─────────────────────────────

/** Proscenium's known-password seed accounts (server/tasks/seed/users.ts). */
const SEED_EMAILS = new Set([
  'admin@newtheatre.org.uk',
  'manager@newtheatre.org.uk',
  'boxoffice@newtheatre.org.uk',
  'user@newtheatre.org.uk',
  'unverified@newtheatre.org.uk',
])

/** Explicit grants applied at migration (rule 4: auth:ADMIN to the ITM). */
const EXPLICIT_GRANTS: Record<string, string[]> = {
  // The ITM's real account. proscenium:ADMIN replaces the neutralised seed
  // admin account (docs/migration.md: "real admin accounts re-created cleanly").
  'matthew.n.adcock@gmail.com': ['auth:ADMIN', 'proscenium:ADMIN'],
}

/**
 * A password on an undeliverable domain can never be reset, so it is pure
 * liability: neutralised like the seed accounts.
 */
function isUndeliverableTestAccount(email: string, password: string | null): boolean {
  if (password === null) return false
  return /@example\.(com|org|net)$|\.invalid$|\.test$|\.example$/.test(email)
}

/**
 * Proscenium users predating the legacy import. Roles held outside this set
 * map to the dormant `ticketing:*` namespace — see docs/migration.md
 */
const preLegacyIds = new Set<string>(
  JSON.parse(readFileSync(join(DATA, 'pre-legacy-proscenium-ids.json'), 'utf8')) as string[],
)

// ── Load sources ────────────────────────────────────────────────────────────

function loadDump(name: string): Database {
  const file = join(DATA, `${name}.sql`)
  if (!existsSync(file)) {
    console.error(`Missing ${file} — run scripts/migrate/export.sh first.`)
    process.exit(1)
  }
  const db = new Database(':memory:')
  // Some dumps carry sqlite_sequence statements from an AUTOINCREMENT past;
  // the table won't exist in a fresh DB whose schema has no AUTOINCREMENT.
  const sql = readFileSync(file, 'utf8')
    .split('\n')
    .filter(line => !line.includes('sqlite_sequence'))
    .join('\n')
  db.exec(sql)
  return db
}

/** Proscenium mixes SQLite 'YYYY-MM-DD HH:MM:SS' (UTC) and ISO-8601 strings. */
function toMs(value: string | null): number | null {
  if (!value) return null
  const iso = value.includes('T') ? value : `${value.replace(' ', 'T')}Z`
  const ms = new Date(iso).getTime()
  if (Number.isNaN(ms)) throw new Error(`Unparseable timestamp: ${value}`)
  return ms
}

/** Deterministic 21-char id from a stable key (nanoid-shaped, not random). */
function stableId(key: string): string {
  return createHash('sha256').update(key).digest('base64url').slice(0, 21)
}

function sqlString(value: string | null): string {
  return value === null ? 'NULL' : `'${value.replace(/'/g, '\'\'')}'`
}

interface ProsUser {
  id: string
  email: string
  name: string
  password: string | null
  email_verified: number
  created_at: string
  last_login: string | null
}
interface RoomsUser {
  id: string
  email: string
  name: string
  password_hash: string
  role: string
  created_at: string
}

const pros = loadDump('proscenium')
const rooms = loadDump('rooms')

const prosUsersRaw = pros.prepare('SELECT id, email, name, password, email_verified, created_at, last_login FROM users').all() as ProsUser[]

// Proscenium's email uniqueness is case-sensitive, so lowercasing collides.
// Fold rules: docs/migration.md#case-duplicate-fold

const prosLatestRes = new Map<string, number>()
for (const row of pros.prepare('SELECT user_id, max(created_at) latest FROM reservations GROUP BY user_id').all() as { user_id: string, latest: string }[]) {
  prosLatestRes.set(row.user_id, toMs(row.latest)!)
}

function prosActivityOf(u: ProsUser): number {
  return Math.max(toMs(u.last_login) ?? 0, toMs(u.created_at) ?? 0, prosLatestRes.get(u.id) ?? 0)
}

const byLowerEmail = new Map<string, ProsUser[]>()
for (const u of prosUsersRaw) {
  const key = u.email.toLowerCase()
  byLowerEmail.set(key, [...(byLowerEmail.get(key) ?? []), u])
}

interface FoldedProsUser extends ProsUser {
  extraLegacyIds: string[]
}

const prosUsers: FoldedProsUser[] = []
const prosFolds: { email: string, winner: string, losers: string[] }[] = []

for (const [email, group] of byLowerEmail) {
  if (group.length === 1) {
    prosUsers.push({ ...group[0]!, extraLegacyIds: [] })
    continue
  }
  const sorted = [...group].sort((a, b) => (toMs(a.created_at)! - toMs(b.created_at)!) || a.id.localeCompare(b.id))
  const winner = sorted[0]!
  const losers = sorted.slice(1)
  const mostActive = [...group].sort((a, b) => prosActivityOf(b) - prosActivityOf(a))[0]!
  prosUsers.push({
    ...winner,
    name: mostActive.name.trim(),
    password: group.map(u => u.password).find(p => p !== null) ?? null,
    email_verified: Math.max(...group.map(u => u.email_verified)),
    last_login: group.map(u => u.last_login).filter(Boolean).sort().at(-1) ?? null,
    extraLegacyIds: losers.map(l => l.id),
  })
  prosFolds.push({ email, winner: winner.id, losers: losers.map(l => l.id) })
}
const prosRoles = pros.prepare('SELECT user_id, role FROM user_roles').all() as { user_id: string, role: string }[]
const roomsUsers = rooms.prepare('SELECT id, email, name, password_hash, role, created_at FROM users').all() as RoomsUser[]
const roomsLastActivity = new Map<string, number>()
for (const row of rooms.prepare('SELECT user_id, max(created_at) latest FROM bookings WHERE user_id IS NOT NULL GROUP BY user_id').all() as { user_id: string, latest: string }[]) {
  roomsLastActivity.set(row.user_id, toMs(row.latest)!)
}

const prosRolesByUser = new Map<string, string[]>()
for (const r of prosRoles) {
  prosRolesByUser.set(r.user_id, [...(prosRolesByUser.get(r.user_id) ?? []), r.role])
}

// ── Merge (docs/migration.md rules 1–3, keyed on lower(email)) ──────────────

interface MergedUser {
  id: string
  email: string
  name: string
  password: string | null
  verified: number
  disabled: number
  createdAt: number
  lastLogin: number | null
  roles: string[]
  legacy: { source: 'proscenium' | 'rooms', legacyId: string }[]
  neutralisedSeed: boolean
  mergedFromBoth: boolean
}

const roomsByEmail = new Map(roomsUsers.map(u => [u.email.toLowerCase(), u]))
const claimedRoomsEmails = new Set<string>()
const merged: MergedUser[] = []

for (const p of prosUsers) {
  const email = p.email.toLowerCase()
  const r = roomsByEmail.get(email)
  if (r) claimedRoomsEmails.add(email)

  const isSeed = SEED_EMAILS.has(email) || isUndeliverableTestAccount(email, p.password)

  // Rule 1/2: Proscenium row wins; its id is canonical. Password: Proscenium's
  // unless NULL (shadow) and rooms has one. Name: more recently active side.
  const prosActivity = Math.max(toMs(p.last_login) ?? 0, toMs(p.created_at) ?? 0)
  const roomsActivity = r ? Math.max(toMs(r.created_at) ?? 0, roomsLastActivity.get(r.id) ?? 0) : 0

  const roles = [...new Set([
    // Pre-legacy users keep live proscenium:* roles; users the import created get
    // dormant ticketing:* ones.
    ...[p.id, ...p.extraLegacyIds].flatMap(id => (prosRolesByUser.get(id) ?? [])
      .map(role => `${preLegacyIds.has(id) ? 'proscenium' : 'ticketing'}:${role}`)),
    ...(r && r.role === 'ADMIN' ? ['rooms:ADMIN'] : []),
  ])]

  merged.push({
    id: p.id,
    email,
    name: r && roomsActivity > prosActivity ? r.name : p.name,
    // Deviation (README): seed accounts with FK'd reservations are kept but
    // neutralised — password NULL, disabled, no roles, unverified.
    password: isSeed ? null : (p.password ?? r?.password_hash ?? null),
    verified: isSeed ? 0 : p.email_verified,
    disabled: isSeed ? 1 : 0,
    createdAt: toMs(p.created_at)!,
    lastLogin: toMs(p.last_login),
    roles: isSeed ? [] : roles,
    legacy: [
      { source: 'proscenium', legacyId: p.id },
      ...p.extraLegacyIds.map(id => ({ source: 'proscenium' as const, legacyId: id })),
      ...(r ? [{ source: 'rooms' as const, legacyId: r.id }] : []),
    ],
    neutralisedSeed: isSeed,
    mergedFromBoth: !!r,
  })
}

// Rule 3: rooms-only users keep their UUID as the canonical id.
for (const r of roomsUsers) {
  const email = r.email.toLowerCase()
  if (claimedRoomsEmails.has(email)) continue

  merged.push({
    id: r.id,
    email,
    name: r.name,
    password: r.password_hash,
    verified: 0,
    disabled: 0,
    createdAt: toMs(r.created_at)!,
    lastLogin: null,
    roles: r.role === 'ADMIN' ? ['rooms:ADMIN'] : [],
    legacy: [{ source: 'rooms', legacyId: r.id }],
    neutralisedSeed: false,
    mergedFromBoth: false,
  })
}

// Rule 4: explicit grants.
for (const [email, grants] of Object.entries(EXPLICIT_GRANTS)) {
  const user = merged.find(u => u.email === email)
  if (!user) throw new Error(`Explicit grant target not found in sources: ${email}`)
  for (const grant of grants) {
    if (!user.roles.includes(grant)) user.roles.push(grant)
  }
}

// Duplicate-email safety net (emails are unique per source, but assert the merge).
const seen = new Set<string>()
for (const u of merged) {
  if (seen.has(u.email)) throw new Error(`Duplicate email after merge: ${u.email}`)
  seen.add(u.email)
}

// ── Emit auth-import.sql ────────────────────────────────────────────────────

mkdirSync(OUT, { recursive: true })
const now = Date.now()

const lines: string[] = [
  '-- Generated by scripts/migrate/build.ts — do not edit by hand.',
  '-- Idempotence: import into an EMPTY auth users table only.',
  'PRAGMA defer_foreign_keys = on;',
]

for (const u of merged) {
  lines.push(
    `INSERT INTO users (id, email, name, password, email_verified, google_sub, pending_google_email, disabled, session_epoch, created_at, updated_at, last_login) VALUES (`
    + `${sqlString(u.id)}, ${sqlString(u.email)}, ${sqlString(u.name)}, ${sqlString(u.password)}, `
    + `${u.verified}, NULL, NULL, ${u.disabled}, 0, ${u.createdAt}, ${now}, ${u.lastLogin ?? 'NULL'});`,
  )
  for (const role of u.roles) {
    lines.push(`INSERT INTO user_roles (id, user_id, role) VALUES (${sqlString(stableId(`role:${u.id}:${role}`))}, ${sqlString(u.id)}, ${sqlString(role)});`)
  }
  for (const l of u.legacy) {
    lines.push(`INSERT INTO legacy_ids (id, user_id, source, legacy_id) VALUES (${sqlString(stableId(`legacy:${l.source}:${l.legacyId}`))}, ${sqlString(u.id)}, ${sqlString(l.source)}, ${sqlString(l.legacyId)});`)
  }
}

writeFileSync(join(OUT, 'auth-import.sql'), lines.join('\n') + '\n')

// D1 caps statements per request — also emit ordered chunks for the real
// run (per-user emit order means dependents always follow their user row).
const CHUNK_SIZE = 4000
const statements = lines.filter(l => !l.startsWith('--') && !l.startsWith('PRAGMA'))
let chunkCount = 0
for (let i = 0; i < statements.length; i += CHUNK_SIZE) {
  chunkCount += 1
  const chunk = ['PRAGMA defer_foreign_keys = on;', ...statements.slice(i, i + CHUNK_SIZE)]
  writeFileSync(join(OUT, `auth-import.chunk-${String(chunkCount).padStart(2, '0')}.sql`), chunk.join('\n') + '\n')
}

// ── Emit proscenium-fixes.sql (case-duplicate shadow fold) ──────────────────

const prosFixes: string[] = [
  '-- Generated by scripts/migrate/build.ts — do not edit by hand.',
  '-- Folds case-duplicate shadow accounts (same person, different email',
  '-- capitalisation) into their canonical row. Safe to run in the LIVE',
  '-- proscenium DB at migration time: reservations are re-pointed to the',
  '-- surviving row before the loser rows are deleted.',
]
for (const fold of prosFolds) {
  for (const loser of fold.losers) {
    prosFixes.push(`UPDATE reservations SET user_id = ${sqlString(fold.winner)} WHERE user_id = ${sqlString(loser)};`)
    prosFixes.push(`DELETE FROM users WHERE id = ${sqlString(loser)};`)
  }
}
writeFileSync(join(OUT, 'proscenium-fixes.sql'), prosFixes.join('\n') + '\n')

// ── Emit rooms-fixes.sql (docs/migration.md#per-app-data-fixes) ─────────────

const fixes: string[] = [
  '-- Generated by scripts/migrate/build.ts — do not edit by hand.',
  '-- Runs INSIDE rooms\'s Phase 4 integration migration, AFTER its users',
  '-- table is slimmed to the mirror shape and mirror rows exist for the',
  '-- canonical ids below. Re-points rows of users merged with a Proscenium',
  '-- identity (rooms-only users kept their UUID — no rewrite needed).',
]

const remapped = merged.filter(u => u.mergedFromBoth)
for (const u of remapped) {
  const roomsId = u.legacy.find(l => l.source === 'rooms')!.legacyId
  fixes.push(`UPDATE bookings SET user_id = ${sqlString(u.id)} WHERE user_id = ${sqlString(roomsId)};`)
  fixes.push(`UPDATE push_subscriptions SET user_id = ${sqlString(u.id)} WHERE user_id = ${sqlString(roomsId)};`)
}

writeFileSync(join(OUT, 'rooms-fixes.sql'), fixes.join('\n') + '\n')

// ── Report ──────────────────────────────────────────────────────────────────

const report = {
  builtAt: new Date(now).toISOString(),
  sources: {
    proscenium: { users: prosUsersRaw.length, distinctEmails: prosUsers.length, roles: prosRoles.length },
    rooms: { users: roomsUsers.length, admins: roomsUsers.filter(u => u.role === 'ADMIN').length },
  },
  caseDuplicateFolds: prosFolds,
  merged: {
    total: merged.length,
    fromBoth: remapped.length,
    prosceniumOnly: merged.filter(u => !u.mergedFromBoth && u.legacy.some(l => l.source === 'proscenium')).length,
    roomsOnly: merged.filter(u => u.legacy.every(l => l.source === 'rooms')).length,
    shadowAccounts: merged.filter(u => u.password === null && !u.neutralisedSeed).length,
    neutralised: merged.filter(u => u.neutralisedSeed).map(u => u.email),
    tookRoomsHash: merged.filter(u => u.mergedFromBoth && u.password !== null && !prosUsers.find(p => p.id === u.id)?.password).length,
  },
  roles: Object.fromEntries(
    [...merged.flatMap(u => u.roles).reduce((m, r) => m.set(r, (m.get(r) ?? 0) + 1), new Map<string, number>())].sort(),
  ),
  legacyIdRows: merged.reduce((n, u) => n + u.legacy.length, 0),
  roomsBookingRewrites: remapped.length,
  importChunks: chunkCount,
}

writeFileSync(join(OUT, 'report.json'), JSON.stringify(report, null, 2) + '\n')
console.info(JSON.stringify(report, null, 2))
