import { db, schema } from '@nuxthub/db'
import { eq } from 'drizzle-orm'
import { z } from 'zod'

const bodySchema = z.object({
  email: emailSchema,
  name: z.string().min(1, 'Name is required').max(200),
  roles: z.array(roleGrantSchema).max(MAX_GRANTS_PER_REQUEST).default([]),
})

/**
 * Admin-create a user. Sends a set-password email rather than returning a
 * generated password.
 */
export default defineEventHandler(async (event) => {
  const { user: admin } = await requireAuthAdmin(event)
  const { email, name, roles } = await readValidatedBody(event, bodySchema.parse)

  const existing = await db.select().from(schema.users).where(eq(schema.users.email, email)).get()
  if (existing) {
    throw createError({ statusCode: 409, statusMessage: 'A user with this email already exists' })
  }

  // A new user holds nothing, so every requested grant must be defined.
  await assertGrantsDefined(roles, new Set())

  const [user] = await db.insert(schema.users).values({
    email,
    name,
    password: null,
    verified: false,
  }).returning()

  if (!user) {
    throw createError({ statusCode: 500, statusMessage: 'Failed to create user' })
  }

  for (const grant of roles) {
    await db.insert(schema.userRoles).values({
      userId: user.id,
      role: grant.role,
      expiresAt: grant.expiresAt === null ? null : new Date(grant.expiresAt),
      note: grant.note,
      grantedBy: admin.id,
      grantedAt: new Date(),
    })
  }

  assertPasswordAllowed(user.email)

  const token = await createPasswordResetToken(user.id, TOKEN_EXPIRY.ADMIN_PASSWORD_RESET)
  await sendPasswordResetEmail(user.email, token)

  await writeAudit({
    actorUserId: admin.id,
    action: 'user.created',
    target: user.id,
    detail: { email, roles: roles.map(g => ({ role: g.role, expiresAt: g.expiresAt })) },
  })

  return { user: adminUserView(user, await loadRoleGrants(user.id)) }
})
