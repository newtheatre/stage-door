/**
 * Session refresh core: re-reads user and roles from the DB and re-seals.
 * Rejects disabled or erased users and stale epochs.
 */

import type { H3Event } from 'h3'
import { db, schema } from '@nuxthub/db'
import { eq } from 'drizzle-orm'

export type RefreshResult
  = | { ok: true, user: { id: string, email: string, name: string, verified: boolean, guest: boolean, roles: string[] } }
    | { ok: false, reason: 'no-session' | 'gone' | 'disabled' | 'stale-epoch' }

/**
 * Refresh the caller's session in place. On failure the session is cleared.
 * the caller decides whether to redirect (GET) or 401 (POST).
 */
export async function refreshSession(event: H3Event): Promise<RefreshResult> {
  const session = await getUserSession(event)
  if (!session.user) {
    return { ok: false, reason: 'no-session' }
  }

  const user = await db.select().from(schema.users)
    .where(eq(schema.users.id, session.user.id)).get()

  const failure = livenessFailure(session, user)
  if (failure) {
    await clearUserSession(event)
    return { ok: false, reason: failure }
  }

  await reSealSession(event, user!, session.loggedInAt)

  const fresh = await getUserSession(event)
  return { ok: true, user: fresh.user! }
}
