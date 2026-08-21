import { db, schema } from '@nuxthub/db'
import { eq } from 'drizzle-orm'
import { z } from 'zod'

const bodySchema = z.object({
  email: emailSchema,
  name: z.string().min(1, 'Name is required').max(200),
})

/**
 * Service-token only (ADR-0007). Match on lowercased email or create a
 * password-less user. Idempotent.
 */
export default defineEventHandler(async (event) => {
  const serviceToken = await requireServiceToken(event)
  const { email, name } = await readValidatedBody(event, bodySchema.parse)

  const existing = await db.select().from(schema.users).where(eq(schema.users.email, email)).get()

  if (existing) {
    return {
      id: existing.id,
      existing: true,
      guest: existing.password === null && existing.googleSub === null,
    }
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

  await writeAudit({
    actorUserId: null,
    action: 'user.shadow-created',
    target: user.id,
    detail: { service: serviceToken.name },
  })

  return { id: user.id, existing: false, guest: true }
})
