import { db, schema } from '@nuxthub/db'
import { eq } from 'drizzle-orm'
import { z } from 'zod/v4'

const bodySchema = z.object({
  name: z.string().min(1).max(200).optional(),
  email: emailSchema.optional(),
})

/**
 * Update own name and email. An email change resets verification; a taken
 * address gets a generic response and mails the existing owner.
 */
export default defineEventHandler(async (event) => {
  const { user, loggedInAt } = await requireAccountUser(event)
  const { name, email } = await readValidatedBody(event, bodySchema.parse)

  const emailChanged = email !== undefined && email !== user.email

  if (emailChanged && isUndeliverableEmail(email)) {
    throw createError({ statusCode: 400, statusMessage: 'That email address cannot receive mail' })
  }

  if (emailChanged) {
    const clash = await db.select().from(schema.users).where(eq(schema.users.email, email)).get()
    if (clash && clash.id !== user.id) {
      // Same body as success; the requested address gets the "you already
      // have an account" note and nothing changes.
      await sendAccountExistsEmail(email)
      return { ok: true }
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

  const roles = await loadRoles(user.id)
  await sealUserSession(event, updated!, roles, { fresh: false, loggedInAt })

  return { ok: true }
})
