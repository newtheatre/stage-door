import { db, schema } from '@nuxthub/db'
import { eq, sql } from 'drizzle-orm'
import { z } from 'zod'

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
    // A Workspace address is proven by signing in with Google, never by
    // editing this field (ADR-0012).
    assertPasswordAllowed(email)

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
      // Re-pointing the row at another address is credential-adjacent: other
      // sessions must not survive it.
      ...(emailChanged ? { email, verified: false, sessionEpoch: sql`${schema.users.sessionEpoch} + 1` } : {}),
    })
    .where(eq(schema.users.id, user.id))
    .returning()

  if (emailChanged) {
    const token = await createEmailVerificationToken(user.id)
    await sendVerificationEmail(email, token)
  }

  await writeAudit({
    actorUserId: user.id,
    action: 'user.updated',
    target: user.id,
    // The fact, not the values: neither the address nor the name may outlive
    // an erasure in here (same rule as user.erased).
    detail: {
      via: 'self-service',
      ...(name !== undefined ? { nameChanged: true } : {}),
      ...(emailChanged ? { emailChanged: true } : {}),
    },
  })

  await reSealSession(event, updated!, loggedInAt)

  return { ok: true }
})
