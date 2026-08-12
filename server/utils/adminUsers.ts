import { db, schema } from '@nuxthub/db'
import { eq } from 'drizzle-orm'
import type { RoleGrant } from './session'

type UserRow = typeof schema.users.$inferSelect

/** Load a user by route param or 404. */
export async function loadUserOr404(id: string | undefined): Promise<UserRow> {
  const user = id
    ? await db.select().from(schema.users).where(eq(schema.users.id, id)).get()
    : undefined

  if (!user) {
    throw createError({ statusCode: 404, statusMessage: 'User not found' })
  }
  return user
}

/**
 * The admin-facing profile shape — never includes the password hash.
 * `roles` stays the active-only string list (what the session would carry);
 * `grants` is the full per-grant detail including expired rows (ADR-0011).
 */
export function adminUserView(user: UserRow, grants: RoleGrant[] = []) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    verified: user.verified,
    guest: user.password === null && user.googleSub === null,
    hasPassword: user.password !== null,
    googleLinked: user.googleSub !== null,
    pendingGoogleEmail: user.pendingGoogleEmail,
    disabled: user.disabled,
    sessionEpoch: user.sessionEpoch,
    createdAt: user.createdAt,
    lastLogin: user.lastLogin,
    roles: grants.filter(g => !g.expired).map(g => g.role),
    grants,
  }
}
