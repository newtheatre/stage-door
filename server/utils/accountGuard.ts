/**
 * Session liveness, in one place. The DB is right here, so re-check
 * existence, disabled state and epoch: a stale cookie must not act.
 */

import type { H3Event } from 'h3'
import { db, schema } from '@nuxthub/db'
import { eq } from 'drizzle-orm'

type UserRow = typeof schema.users.$inferSelect

export type LivenessFailure = 'gone' | 'disabled' | 'stale-epoch'

/** Why this session cannot act, or null if it can. */
export function livenessFailure(
  session: { epoch?: number },
  user: UserRow | undefined,
): LivenessFailure | null {
  if (!user) return 'gone'
  if (user.disabled) return 'disabled'
  // Force-logout, password reset or a merge elsewhere: this cookie is dead.
  if ((session.epoch ?? -1) !== user.sessionEpoch) return 'stale-epoch'
  return null
}

/**
 * The whole authenticated surface builds on this. Clears the cookie and 401s
 * rather than reporting a reason, which would be an oracle.
 */
export async function requireLiveUser(event: H3Event): Promise<{ user: UserRow, loggedInAt: number }> {
  const session = await requireUserSession(event)

  const user = await db.select().from(schema.users)
    .where(eq(schema.users.id, session.user.id)).get()

  if (livenessFailure(session, user)) {
    await clearUserSession(event)
    throw createError({ statusCode: 401, statusMessage: 'Session no longer valid' })
  }

  return { user: user!, loggedInAt: session.loggedInAt }
}

/** Guard for `/api/account/*`. */
export const requireAccountUser = requireLiveUser
