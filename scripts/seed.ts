/**
 * Dev-only seed. Credentials are generated at runtime and printed once.
 * Refuses to run in production or against a remote database.
 */

import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { createClient } from '@libsql/client'
import { drizzle } from 'drizzle-orm/libsql'
import { inArray } from 'drizzle-orm'
import { APP_MANIFEST } from '../shared/utils/appManifest'
import { Hash } from '@adonisjs/hash'
import { Scrypt } from '@adonisjs/hash/drivers/scrypt'
import { users, userRoles, roleDefinitions } from '../server/db/schema/user'

if (process.env.NODE_ENV === 'production') {
  console.error('Refusing to seed: NODE_ENV is production.')
  process.exit(1)
}

if (process.env.NUXT_HUB_CLOUDFLARE_DATABASE_ID || process.env.NUXT_HUB_CLOUDFLARE_API_TOKEN) {
  console.error('Refusing to seed: remote D1 credentials are set in this environment.')
  process.exit(1)
}

const dbPath = join(import.meta.dirname, '../.data/db/sqlite.db')
if (!existsSync(dbPath)) {
  console.error(`No local database at ${dbPath}: run \`bun run db:migrate\` (or \`bun run dev\` once) first.`)
  process.exit(1)
}

const db = drizzle(createClient({ url: `file:${dbPath}` }))

// Same scrypt defaults as nuxt-auth-utils' hashPassword: hashes verify
// identically at login.
const hash = new Hash(new Scrypt({}))

function generatePassword(): string {
  // Random, and guaranteed to satisfy the password policy.
  return `Aa1-${randomBytes(9).toString('base64url')}`
}

// Addresses must NOT use a reserved TLD: isUndeliverableEmail treats those as
// anonymised placeholders and would hide every seeded user.
const seedUsers = [
  { email: 'admin@dev.newtheatre.org.uk', name: 'Dev Admin', roles: ['auth:ADMIN'], verified: true },
  { email: 'member@dev.newtheatre.org.uk', name: 'Dev Member', roles: ['proscenium:BOX_OFFICE'], verified: true },
  { email: 'audience@dev.newtheatre.org.uk', name: 'Dev Audience', roles: [], verified: false },
  { email: 'guest@dev.newtheatre.org.uk', name: 'Dev Guest (shadow)', roles: [], verified: false, shadow: true },
] as const

// Idempotent: replace previous seed users wholesale.
await db.delete(users).where(
  inArray(users.email, seedUsers.map(u => u.email)),
)

console.info('Seeded dev users (credentials shown once, random each run):\n')

for (const seedUser of seedUsers) {
  const password = 'shadow' in seedUser && seedUser.shadow ? null : generatePassword()

  const [user] = await db.insert(users).values({
    email: seedUser.email,
    name: seedUser.name,
    password: password === null ? null : await hash.make(password),
    verified: seedUser.verified,
  }).returning()

  if (!user) throw new Error(`Failed to insert ${seedUser.email}`)

  for (const role of seedUser.roles) {
    await db.insert(userRoles).values({ userId: user.id, role })
  }

  const rolesNote = seedUser.roles.length ? `  [${seedUser.roles.join(', ')}]` : ''
  console.info(`  ${seedUser.email}  ${password ?? '(no password: shadow account)'}${rolesNote}`)
}

// Role definitions so the admin grant dropdown isn't empty in dev.
const seedDefinitions = [
  // auth:ADMIN now comes from this service's own manifest (ADR-0024), which
  // the seed syncs below rather than declaring here.
  { namespace: 'proscenium', role: 'ADMIN', description: 'Full site + box office admin', defaultExpiryKind: 'committee-year' as const },
  { namespace: 'proscenium', role: 'MANAGER', description: 'Theatre manager tools', defaultExpiryKind: 'committee-year' as const },
  { namespace: 'proscenium', role: 'BOX_OFFICE', description: 'Sell and collect tickets', defaultExpiryKind: 'committee-year' as const },
  { namespace: 'rooms', role: 'ADMIN', description: 'Approve and manage room bookings', defaultExpiryKind: 'committee-year' as const },
]
for (const definition of seedDefinitions) {
  await db.insert(roleDefinitions).values(definition).onConflictDoNothing()
}

// This service's own roles, from its own manifest, so the dropdown matches
// production without waiting for the daily sync (ADR-0024).
for (const role of APP_MANIFEST.roles) {
  await db.insert(roleDefinitions).values({
    namespace: APP_MANIFEST.namespace,
    role: role.role,
    description: role.description,
    defaultExpiryKind: role.defaultExpiry.kind,
    source: 'manifest' as const,
    manifestVersion: APP_MANIFEST.version,
  }).onConflictDoNothing()
}
console.info(`\nSeeded ${seedDefinitions.length + APP_MANIFEST.roles.length} role definitions.`)

console.info('\nLog in at http://localhost:3000/login')
