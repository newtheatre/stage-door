import { db, schema } from '@nuxthub/db'
import { eq } from 'drizzle-orm'
import { z } from 'zod/v4'

const bodySchema = z.object({
  name: z.string().min(1).max(200).optional(),
  email: emailSchema.optional(),
})

/**
 * PUT /api/users/:id — update name/email (admin). An email change resets
 * `verified` and triggers a fresh verification email.
 */
export default defineEventHandler(async (event) => {
  const { user: admin } = await requireAuthAdmin(event)
  const user = await loadUserOr404(getRouterParam(event, 'id'))
  const { name, email } = await readValidatedBody(event, bodySchema.parse)

  const emailChanged = email !== undefined && email !== user.email

  if (emailChanged) {
    const clash = await db.select().from(schema.users).where(eq(schema.users.email, email)).get()
    if (clash && clash.id !== user.id) {
      throw createError({ statusCode: 409, statusMessage: 'A user with this email already exists' })
    }
  }

  const [updated] = await db.update(schema.users)
    .set({
      ...(name !== undefined ? { name } : {}),
      ...(emailChanged ? { email, verified: false } : {}),
    })
    .where(eq(schema.users.id, user.id))
    .returning()

  if (emailChanged) {
    const token = await createEmailVerificationToken(user.id)
    await sendVerificationEmail(email, token)
  }

  await writeAudit({
    actorUserId: admin.id,
    action: 'user.updated',
    target: user.id,
    detail: {
      ...(name !== undefined ? { name } : {}),
      ...(emailChanged ? { email: { from: user.email, to: email } } : {}),
    },
  })

  return { user: adminUserView(updated!, await loadRoleGrants(user.id)) }
})
