/**
 * Session refresh core (docs/api-reference.md#session-maintenance).
 *
 * Re-reads the user and roles from the DB and re-seals the cookie —
 * consumer apps bounce privileged requests here when `refreshedAt` is older
 * than 15 minutes. Rejects disabled/erased users and stale epochs.
 */

import type { H3Event } from 'h3'
import { db, schema } from '@nuxthub/db'
import { eq } from 'drizzle-orm'

export type RefreshResult
  = | { ok: true, user: { id: string, email: string, name: string, verified: boolean, guest: boolean, roles: string[] } }
    | { ok: false, reason: 'no-session' | 'gone' | 'disabled' | 'stale-epoch' }

/**
 * Refresh the caller's session in place. On failure the session is cleared —
 * the caller decides whether to redirect (GET) or 401 (POST).
 */
export async function refreshSession(event: H3Event): Promise<RefreshResult> {
  const session = await getUserSession(event)
  if (!session.user) {
    return { ok: false, reason: 'no-session' }
  }

  const user = await db.select().from(schema.users)
    .where(eq(schema.users.id, session.user.id)).get()

  if (!user) {
    await clearUserSession(event)
    return { ok: false, reason: 'gone' }
  }
  if (user.disabled) {
    await clearUserSession(event)
    return { ok: false, reason: 'disabled' }
  }
  if ((session.epoch ?? -1) !== user.sessionEpoch) {
    // Force-logout / password reset elsewhere — this cookie is dead.
    await clearUserSession(event)
    return { ok: false, reason: 'stale-epoch' }
  }

  const roles = await loadRoles(user.id)
  await sealUserSession(event, user, roles, { fresh: false, loggedInAt: session.loggedInAt })

  const fresh = await getUserSession(event)
  return { ok: true, user: fresh.user! }
}
