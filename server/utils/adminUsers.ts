import { db, schema } from '@nuxthub/db'
import { and, eq, like, or, sql } from 'drizzle-orm'
import type { RoleGrant } from './session'

// Anonymised accounts live on undeliverable domains. SQL, so the filter
// happens in the database.
const UNDELIVERABLE_LIKE = [
  '%.invalid', '%.test', '%.example', '%.localhost',
  '%@example.com', '%@example.org', '%@example.net',
]

/** WHERE: this users row is an anonymised/placeholder account. */
export function isAnonymisedRow() {
  return or(...UNDELIVERABLE_LIKE.map(p => like(schema.users.email, p)))
}

/** WHERE: this users row is a real, mailable account. */
export function isRealRow() {
  return and(...UNDELIVERABLE_LIKE.map(p => sql`${schema.users.email} NOT LIKE ${p}`))
}

/** The address eraseUser rewrites to. The only marker an erased row carries. */
export const ANONYMISED_SUFFIX = '@anonymised.invalid'

type UserRow = typeof schema.users.$inferSelect

/**
 * Erasure is irreversible (docs/gdpr-retention.md): writing identity back
 * over an erased row re-identifies it while every app stays scrubbed.
 */
export function assertNotAnonymised(user: UserRow): void {
  if (user.email.endsWith(ANONYMISED_SUFFIX)) {
    throw createError({
      statusCode: 400,
      statusMessage: 'This account has been erased and cannot be modified',
    })
  }
}

/** Load a user by route param or 404. */
export async function loadUserOr404(id: string | undefined): Promise<UserRow> {
  const user = id
    ? await db.select().from(schema.users).where(eq(schema.users.id, id)).get()
    : undefined

  if (!user) {
    throw createError({ statusCode: 404, statusMessage: 'User not found' })
  }
  return user
}

/**
 * The admin-facing profile shape — never the password hash. `roles` is
 * active-only; `grants` carries the full per-grant detail (ADR-0011).
 */
export function adminUserView(user: UserRow, grants: RoleGrant[] = []) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    verified: user.verified,
    guest: user.password === null && user.googleSub === null,
    hasPassword: user.password !== null,
    googleLinked: user.googleSub !== null,
    pendingGoogleEmail: user.pendingGoogleEmail,
    disabled: user.disabled,
    sessionEpoch: user.sessionEpoch,
    createdAt: user.createdAt,
    lastLogin: user.lastLogin,
    roles: grants.filter(g => !g.expired).map(g => g.role),
    grants,
  }
}
