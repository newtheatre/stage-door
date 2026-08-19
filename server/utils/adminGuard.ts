/**
 * Guard for the admin API surface: session plus `auth:ADMIN`, re-checked
 * against the DB every time. Revocation is instant here.
 */

import type { H3Event } from 'h3'
import type { schema } from '@nuxthub/db'

type UserRow = typeof schema.users.$inferSelect

export async function requireAuthAdmin(event: H3Event): Promise<{ user: UserRow, roles: string[] }> {
  // Liveness first, and only here: a divergence between the two guards would
  // leave the privileged surface accepting what the account surface rejects.
  const { user } = await requireLiveUser(event)

  const roles = await loadRoles(user.id)
  if (!roles.includes('auth:ADMIN')) {
    throw createError({ statusCode: 403, statusMessage: 'Admin access required' })
  }

  // A privileged password account that has not enrolled keeps its session but
  // does no admin work until it does (ADR-0012).
  if (await isMfaRequired(user, roles) && (await enrolledFactors(user.id)).length === 0) {
    throw createError({
      statusCode: 403,
      statusMessage: 'Set up two-factor authentication on your account before using admin tools',
      data: { mfaEnrolmentRequired: true },
    })
  }

  return { user, roles }
}
