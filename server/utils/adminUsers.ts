import { db, schema } from '@nuxthub/db'
import { and, eq, like, or, sql } from 'drizzle-orm'
import type { RoleGrant } from './session'
import { UNDELIVERABLE_SUFFIXES } from './validation'

// The same list isUndeliverableEmail uses, as LIKE patterns, so the filter
// happens in the database and the two cannot drift.
const UNDELIVERABLE_LIKE = UNDELIVERABLE_SUFFIXES.map(suffix => `%${suffix}`)

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

/**
 * Load a user by route param or 404. `notSelf` makes each admin route state
 * its answer to "may this be aimed at me?" where it loads its target.
 */
export async function loadUserOr404(
  id: string | undefined,
  opts: { notSelf?: { actorId: string, message: string } } = {},
): Promise<UserRow> {
  const user = id
    ? await db.select().from(schema.users).where(eq(schema.users.id, id)).get()
    : undefined

  if (!user) {
    throw createError({ statusCode: 404, statusMessage: 'User not found' })
  }

  if (opts.notSelf && user.id === opts.notSelf.actorId) {
    throw createError({ statusCode: 400, statusMessage: opts.notSelf.message })
  }
  return user
}

/**
 * requireAuthAdmin re-reads roles per request, so losing the last one closes
 * every admin route including this one. Recovery means hand-editing D1.
 */
export async function assertNotLastAuthAdmin(userId: string, what: string): Promise<void> {
  const others = await db.select({ userId: schema.userRoles.userId })
    .from(schema.userRoles)
    .where(and(
      eq(schema.userRoles.role, 'auth:ADMIN'),
      sql`${schema.userRoles.userId} <> ${userId}`,
      activeRoleCondition(new Date()),
    ))
    .all()

  if (others.length === 0) {
    throw createError({
      statusCode: 400,
      statusMessage: `${what} would leave nobody with auth:ADMIN: grant it to someone else first`,
    })
  }
}

/** Whether this user currently holds a live auth:ADMIN grant. */
export async function holdsAuthAdmin(userId: string): Promise<boolean> {
  const row = await db.select({ userId: schema.userRoles.userId })
    .from(schema.userRoles)
    .where(and(
      eq(schema.userRoles.userId, userId),
      eq(schema.userRoles.role, 'auth:ADMIN'),
      activeRoleCondition(new Date()),
    ))
    .get()
  return Boolean(row)
}

/**
 * The admin-facing profile shape: never the password hash. `roles` is
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
