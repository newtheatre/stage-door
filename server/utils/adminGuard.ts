/**
 * Guard for `/api/users/*`, `/api/audit`, `/api/service-tokens` and the
 * admin UI's API surface: session + `auth:ADMIN`.
 *
 * Unlike consumer apps (which trust the sealed cookie within the staleness
 * window), the auth service has the database right here — so admin calls
 * re-check the DB every time: account still exists, not disabled, session
 * epoch current, and the role read live. Revocation is instant on this
 * surface.
 */

import type { H3Event } from 'h3'
import { db, schema } from '@nuxthub/db'
import { eq } from 'drizzle-orm'

type UserRow = typeof schema.users.$inferSelect

export async function requireAuthAdmin(event: H3Event): Promise<{ user: UserRow, roles: string[] }> {
  const session = await requireUserSession(event)

  const user = await db.select().from(schema.users)
    .where(eq(schema.users.id, session.user.id)).get()

  if (!user || user.disabled || (session.epoch ?? -1) !== user.sessionEpoch) {
    await clearUserSession(event)
    throw createError({ statusCode: 401, statusMessage: 'Session no longer valid' })
  }

  const roles = await loadRoles(user.id)
  if (!roles.includes('auth:ADMIN')) {
    throw createError({ statusCode: 403, statusMessage: 'Admin access required' })
  }

  return { user, roles }
}
