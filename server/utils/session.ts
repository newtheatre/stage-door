/**
 * Session sealing — the single place the session payload is constructed.
 *
 * This service is the only writer of the `nnt-session` cookie (CLAUDE.md
 * invariant 1); the payload shape is the published contract in
 * docs/session-contract.md and packages/auth-types.
 */

import type { H3Event } from 'h3'
import { db, schema } from '@nuxthub/db'
import { and, eq, gt, isNull, or } from 'drizzle-orm'

type UserRow = typeof schema.users.$inferSelect

/**
 * A grant is active when unexpired (ADR-0011). Reused by every place roles
 * gate behaviour — sessions, the retention sweep's role-holder exemption,
 * the admin list's role filter.
 */
export function activeRoleCondition(now: Date = new Date()) {
  return or(isNull(schema.userRoles.expiresAt), gt(schema.userRoles.expiresAt, now))
}

/**
 * Load a user's ACTIVE scoped roles as flat strings — the session shape.
 * Expiry enforcement lives here: every seal path (login, SSO, verify,
 * refresh, account re-seals) and the admin guard funnel through this, so an
 * expired grant vanishes within the 15-minute staleness window.
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
 * Seal a session for a user per the contract.
 *
 * @param opts.fresh  true for an original login (sets `loggedInAt` to now);
 *                    false for a refresh (preserves the given `loggedInAt`).
 */
export async function sealUserSession(
  event: H3Event,
  user: UserRow,
  roles: string[],
  opts: { fresh: boolean, loggedInAt?: number } = { fresh: true },
): Promise<void> {
  const now = Date.now()

  // replaceUserSession, not setUserSession: set merges into the existing
  // session with defu, which CONCATENATES arrays — a re-seal would duplicate
  // roles. The seal is authoritative; always replace wholesale.
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
