/**
 * Guard for /api/account/*. The DB is right here, so re-check existence,
 * disabled state and epoch: a stale cookie must not manage the account.
 */

import type { H3Event } from 'h3'
import { db, schema } from '@nuxthub/db'
import { eq } from 'drizzle-orm'

type UserRow = typeof schema.users.$inferSelect

export async function requireAccountUser(event: H3Event): Promise<{ user: UserRow, loggedInAt: number }> {
  const session = await requireUserSession(event)

  const user = await db.select().from(schema.users)
    .where(eq(schema.users.id, session.user.id)).get()

  if (!user || user.disabled || (session.epoch ?? -1) !== user.sessionEpoch) {
    await clearUserSession(event)
    throw createError({ statusCode: 401, statusMessage: 'Session no longer valid' })
  }

  return { user, loggedInAt: session.loggedInAt }
}
