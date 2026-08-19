/**
 * Session sealing: the only place the payload is constructed, and this
 * service is its only writer. Shape: docs/session-contract.md
 */

import type { H3Event } from 'h3'
import type { SQL } from 'drizzle-orm'
import { db, schema } from '@nuxthub/db'
import { and, eq, gt, inArray, isNull, or, sql } from 'drizzle-orm'

type UserRow = typeof schema.users.$inferSelect

/**
 * A grant is active when unexpired (ADR-0011). Reused everywhere roles gate
 * behaviour.
 */
export function activeRoleCondition(now: Date = new Date()) {
  return or(isNull(schema.userRoles.expiresAt), gt(schema.userRoles.expiresAt, now))
}

/**
 * Correlated `exists` over one user's active grants, for filtering the users
 * table. `roleMatch` narrows it; build it fresh per request, never at module scope.
 */
export function activeGrantExists(roleMatch: SQL, now: Date = new Date()): SQL {
  return sql`exists (select 1 from ${schema.userRoles} where ${schema.userRoles.userId} = ${schema.users.id} and ${roleMatch} and (${schema.userRoles.expiresAt} is null or ${schema.userRoles.expiresAt} > ${now.getTime()}))`
}

/**
 * An enforcing training prerequisite makes a grant inert (ADR-0019). Never a
 * live call to rehearsal: the snapshot is the authority.
 */
export function eligibilitySatisfiedCondition(now: Date = new Date()): SQL {
  const nowMs = now.getTime()
  return sql`not exists (
    select 1 from ${schema.roleDefinitions} rd
    where rd.role_key = ${schema.userRoles.role}
      and rd.eligibility_mode = 'enforcing'
      and rd.requires_eligibility_key is not null
      and (${schema.userRoles.eligibilityOverrideUntil} is null
           or ${schema.userRoles.eligibilityOverrideUntil} <= ${nowMs})
      and exists (
        select 1 from ${schema.eligibilitySyncs} es
        where es.rule_key = rd.requires_eligibility_key
          and es.last_success_at is not null)
      and not exists (
        select 1 from ${schema.eligibilitySnapshots} snap
        where snap.rule_key = rd.requires_eligibility_key
          and snap.user_id = ${schema.userRoles.userId})
  )`
}

/**
 * Active AND not held inert by training. The seal path only: holder counts and
 * the admin role filter deliberately still count someone blocked on training.
 */
export function effectiveRoleCondition(now: Date = new Date()) {
  return and(activeRoleCondition(now), eligibilitySatisfiedCondition(now))
}

/**
 * Active roles as flat strings. Never memoised beyond a request: an isolate is
 * reused across users, so a module-scope cache leaks roles (ADR-0020).
 */
export async function loadRoles(userId: string): Promise<string[]> {
  const now = new Date()
  const rows = await db.select({ role: schema.userRoles.role }).from(schema.userRoles)
    .where(and(eq(schema.userRoles.userId, userId), effectiveRoleCondition(now)))
    .all()
  return rows.map(r => r.role)
}

/**
 * Effective roles for a bounded set of users, for list views. Callers must
 * keep the set page-sized: this binds one parameter per id plus two.
 */
export async function loadEffectiveRolesFor(userIds: string[], now: Date = new Date()): Promise<Map<string, Set<string>>> {
  const byUser = new Map<string, Set<string>>()
  if (!userIds.length) return byUser

  const rows = await db.select({ userId: schema.userRoles.userId, role: schema.userRoles.role })
    .from(schema.userRoles)
    .where(and(inArray(schema.userRoles.userId, userIds), effectiveRoleCondition(now)))
    .all()

  for (const row of rows) {
    byUser.set(row.userId, (byUser.get(row.userId) ?? new Set()).add(row.role))
  }
  return byUser
}

export interface RoleGrant {
  role: string
  expiresAt: number | null
  grantedAt: number | null
  grantedBy: string | null
  note: string | null
  expired: boolean
  /** Held, unexpired, but blocked by an enforcing training prerequisite. */
  inert: boolean
  overrideUntil: number | null
}

/**
 * Full grant rows INCLUDING expired ones: admin surfaces and the
 * subject-access export (expired grants and their notes are personal data).
 */
export async function loadRoleGrants(userId: string): Promise<RoleGrant[]> {
  const now = Date.now()

  // The second is what the session would actually carry, so the admin can see
  // why a held role is doing nothing. Neither depends on the other.
  const [rows, held] = await Promise.all([
    db.select().from(schema.userRoles).where(eq(schema.userRoles.userId, userId)).all(),
    loadRoles(userId),
  ])
  const effective = new Set(held)

  return rows.map((r) => {
    const expired = r.expiresAt !== null && r.expiresAt.getTime() <= now
    return {
      role: r.role,
      expiresAt: r.expiresAt?.getTime() ?? null,
      grantedAt: r.grantedAt?.getTime() ?? null,
      grantedBy: r.grantedBy,
      note: r.note,
      expired,
      inert: !expired && !effective.has(r.role),
      overrideUntil: r.eligibilityOverrideUntil?.getTime() ?? null,
    }
  })
}

/**
 * Seal a session per the contract. `fresh` distinguishes an original login
 * from a refresh, which preserves the given `loggedInAt`.
 */
export async function sealUserSession(
  event: H3Event,
  user: UserRow,
  roles: string[],
  opts: { fresh: boolean, loggedInAt?: number } = { fresh: true },
): Promise<void> {
  const now = Date.now()

  // replaceUserSession, not setUserSession: set merges with defu, which
  // concatenates arrays, so a re-seal would duplicate roles.
  await replaceUserSession(event, {
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      verified: user.verified,
      guest: user.password === null && user.googleSub === null,
      roles,
    },
    loggedInAt: opts.fresh ? now : (opts.loggedInAt ?? now),
    refreshedAt: now,
    epoch: user.sessionEpoch,
  })
}

/**
 * Re-seal after mutating the row, preserving the original login time. Always
 * pass the row the write returned, or the session carries pre-update values.
 */
export async function reSealSession(event: H3Event, user: UserRow, loggedInAt: number): Promise<void> {
  await sealUserSession(event, user, await loadRoles(user.id), { fresh: false, loggedInAt })
}

/** Seal a fresh (login) session and stamp `last_login`. */
export async function sealLoginSession(event: H3Event, user: UserRow): Promise<void> {
  const roles = await loadRoles(user.id)

  await db.update(schema.users)
    .set({ lastLogin: new Date() })
    .where(eq(schema.users.id, user.id))

  await sealUserSession(event, user, roles, { fresh: true })
}
