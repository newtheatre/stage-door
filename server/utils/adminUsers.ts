import { db, schema } from '@nuxthub/db'
import { eq } from 'drizzle-orm'

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

/** The admin-facing profile shape — never includes the password hash. */
export function adminUserView(user: UserRow, roles: string[] = []) {
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
    roles,
  }
}
