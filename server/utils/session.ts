/**
 * Session sealing — the single place the session payload is constructed.
 *
 * This service is the only writer of the `nnt-session` cookie (CLAUDE.md
 * invariant 1); the payload shape is the published contract in
 * docs/session-contract.md and packages/auth-types.
 */

import type { H3Event } from 'h3'
import { db, schema } from '@nuxthub/db'
import { eq } from 'drizzle-orm'

type UserRow = typeof schema.users.$inferSelect

/** Load a user's scoped roles as flat strings. */
export async function loadRoles(userId: string): Promise<string[]> {
  const rows = await db.select().from(schema.userRoles).where(eq(schema.userRoles.userId, userId)).all()
  return rows.map(r => r.role)
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
