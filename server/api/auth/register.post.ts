import { db, schema } from '@nuxthub/db'
import { eq } from 'drizzle-orm'
import { z } from 'zod/v4'

const bodySchema = z.object({
  email: emailSchema,
  name: z.string().min(1, 'Name is required').max(200),
  password: passwordSchema,
})

/**
 * Create an account, or claim a shadow one in place. All three paths return
 * the same body — docs/api-reference.md
 */
export default defineEventHandler(async (event) => {
  const { email, name, password } = await readValidatedBody(event, bodySchema.parse)

  await enforceRateLimit('register:ip', getClientIP(event))

  // Reserved-TLD addresses can never verify and must never be claimable;
  // Workspace addresses get their account from Google (ADR-0012).
  if (isUndeliverableEmail(email) || isWorkspaceEmail(email)) {
    return { ok: true }
  }

  const existing = await db.select().from(schema.users).where(eq(schema.users.email, email)).get()

  if (existing && (existing.password !== null || existing.googleSub !== null)) {
    await sendAccountExistsEmail(email)
    return { ok: true }
  }

  const hashedPassword = await hashPassword(password)

  const [user] = existing
    ? await db.update(schema.users)
        .set({ password: hashedPassword, name })
        .where(eq(schema.users.id, existing.id))
        .returning()
    : await db.insert(schema.users).values({
        email,
        name,
        password: hashedPassword,
        verified: false,
      }).returning()

  if (!user) {
    throw createError({ statusCode: 500, statusMessage: 'Failed to create user' })
  }

  const verificationToken = await createEmailVerificationToken(user.id)
  await sendVerificationEmail(email, verificationToken)

  await sealLoginSession(event, user)

  return { ok: true }
})
