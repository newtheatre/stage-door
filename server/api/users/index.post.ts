import { db, schema } from '@nuxthub/db'
import { eq } from 'drizzle-orm'
import { nanoid } from 'nanoid'
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

  // Every refusal belongs above the first write: this route mints a
  // set-password token, so the ADR-0012 rule applies to it.
  assertPasswordAllowed(email)

  if (new Set(roles.map(g => g.role)).size !== roles.length) {
    throw createError({ statusCode: 400, statusMessage: 'Duplicate roles in request' })
  }

  // A new user holds nothing, so every requested grant must be defined.
  await assertGrantsDefined(roles, new Set())

  // The id is generated here rather than read back, so the row and its grants
  // are one batch: a user with half their roles and no audit entry is worse.
  const id = nanoid()
  const [[user]] = await db.batch([
    db.insert(schema.users).values({ id, email, name, password: null, verified: false }).returning(),
    ...roles.map(grant => db.insert(schema.userRoles).values({
      userId: id,
      role: grant.role,
      expiresAt: grant.expiresAt === null ? null : new Date(grant.expiresAt),
      note: grant.note,
      grantedBy: admin.id,
      grantedAt: new Date(),
    })),
  ])

  if (!user) {
    throw createError({ statusCode: 500, statusMessage: 'Failed to create user' })
  }

  const token = await createPasswordResetToken(user.id, TOKEN_EXPIRY.ADMIN_PASSWORD_RESET)
  await sendPasswordResetEmail(user.email, token)

  await writeAudit({
    actorUserId: admin.id,
    action: 'user.created',
    target: user.id,
    // The id in `target` identifies the account; the address must not
    // outlive an erasure in here (same rule as user.erased).
    detail: { roles: roles.map(g => ({ role: g.role, expiresAt: g.expiresAt })) },
  })

  return { user: adminUserView(user, await loadRoleGrants(user.id)) }
})
