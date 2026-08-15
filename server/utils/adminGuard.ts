/**
 * Guard for the admin API surface: session plus `auth:ADMIN`, re-checked
 * against the DB every time. Revocation is instant here.
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

  // A privileged password account that has not enrolled keeps its session but
  // does no admin work until it does (ADR-0012).
  if (await isMfaRequired(user) && (await enrolledFactors(user.id)).length === 0) {
    throw createError({
      statusCode: 403,
      statusMessage: 'Set up two-factor authentication on your account before using admin tools',
      data: { mfaEnrolmentRequired: true },
    })
  }

  return { user, roles }
}
