import { db, schema } from '@nuxthub/db'
import { eq, sql } from 'drizzle-orm'
import { z } from 'zod/v4'

const bodySchema = z.object({
  currentPassword: z.string().optional(),
  password: passwordSchema,
})

/**
 * Change, or for SSO-only accounts set, the password. Bumps the session epoch
 * so other sessions die, then re-seals this one.
 */
export default defineEventHandler(async (event) => {
  const { user, loggedInAt } = await requireAccountUser(event)
  const { currentPassword, password } = await readValidatedBody(event, bodySchema.parse)

  if (user.password !== null) {
    const valid = currentPassword !== undefined
      && await verifyPassword(user.password, currentPassword)
    if (!valid) {
      throw createError({ statusCode: 401, statusMessage: 'Current password is incorrect' })
    }
  }

  assertPasswordAllowed(user.email)

  const [updated] = await db.update(schema.users)
    .set({
      password: await hashPassword(password),
      sessionEpoch: sql`${schema.users.sessionEpoch} + 1`,
    })
    .where(eq(schema.users.id, user.id))
    .returning()

  const roles = await loadRoles(user.id)
  await sealUserSession(event, updated!, roles, { fresh: false, loggedInAt })

  return { ok: true }
})
