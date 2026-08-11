import { db, schema } from '@nuxthub/db'
import { eq } from 'drizzle-orm'
import { z } from 'zod/v4'

const bodySchema = z.object({
  email: emailSchema,
  name: z.string().min(1, 'Name is required').max(200),
  roles: z.array(roleSchema).default([]),
})

/**
 * POST /api/users — admin-create a user.
 *
 * Sends a set-password email (24 h token to the reset page) instead of
 * returning a generated password — a deliberate change from rooms's old
 * copy-paste-a-password flow (docs/api-reference.md).
 */
export default defineEventHandler(async (event) => {
  const { user: admin } = await requireAuthAdmin(event)
  const { email, name, roles } = await readValidatedBody(event, bodySchema.parse)

  const existing = await db.select().from(schema.users).where(eq(schema.users.email, email)).get()
  if (existing) {
    throw createError({ statusCode: 409, statusMessage: 'A user with this email already exists' })
  }

  const [user] = await db.insert(schema.users).values({
    email,
    name,
    password: null,
    verified: false,
  }).returning()

  if (!user) {
    throw createError({ statusCode: 500, statusMessage: 'Failed to create user' })
  }

  for (const role of roles) {
    await db.insert(schema.userRoles).values({ userId: user.id, role })
  }

  const token = await createPasswordResetToken(user.id, TOKEN_EXPIRY.ADMIN_PASSWORD_RESET)
  await sendPasswordResetEmail(user.email, token)

  await writeAudit({
    actorUserId: admin.id,
    action: 'user.created',
    target: user.id,
    detail: { email, roles },
  })

  return { user: adminUserView(user, roles) }
})
