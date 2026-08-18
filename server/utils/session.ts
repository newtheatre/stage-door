/**
 * Session sealing — the only place the payload is constructed, and this
 * service is its only writer. Shape: docs/session-contract.md
 */

import type { H3Event } from 'h3'
import type { SQL } from 'drizzle-orm'
import { db, schema } from '@nuxthub/db'
import { and, eq, gt, isNull, or, sql } from 'drizzle-orm'

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
 * Active roles as flat strings. Every seal path funnels through here, which
 * is what makes an expired grant vanish within the staleness window.
 */
export async function loadRoles(userId: string): Promise<string[]> {
  const rows = await db.select().from(schema.userRoles)
    .where(and(eq(schema.userRoles.userId, userId), activeRoleCondition()))
    .all()
  return rows.map(r => r.role)
}

export interface RoleGrant {
  role: string
  expiresAt: number | null
  grantedAt: number | null
  grantedBy: string | null
  note: string | null
  expired: boolean
}

/**
 * Full grant rows INCLUDING expired ones — admin surfaces and the
 * subject-access export (expired grants and their notes are personal data).
 */
export async function loadRoleGrants(userId: string): Promise<RoleGrant[]> {
  const now = Date.now()
  const rows = await db.select().from(schema.userRoles)
    .where(eq(schema.userRoles.userId, userId))
    .all()
  return rows.map(r => ({
    role: r.role,
    expiresAt: r.expiresAt?.getTime() ?? null,
    grantedAt: r.grantedAt?.getTime() ?? null,
    grantedBy: r.grantedBy,
    note: r.note,
    expired: r.expiresAt !== null && r.expiresAt.getTime() <= now,
  }))
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

/** Seal a fresh (login) session and stamp `last_login`. */
export async function sealLoginSession(event: H3Event, user: UserRow): Promise<void> {
  const roles = await loadRoles(user.id)

  await db.update(schema.users)
    .set({ lastLogin: new Date() })
    .where(eq(schema.users.id, user.id))

  await sealUserSession(event, user, roles, { fresh: true })
}
