import { db, schema } from '@nuxthub/db'
import { eq } from 'drizzle-orm'
import { z } from 'zod/v4'

const bodySchema = z.object({
  email: emailSchema,
  name: z.string().min(1, 'Name is required').max(200),
  password: passwordSchema,
})

/**
 * POST /api/auth/register — create an account with email and password.
 *
 * Three paths, one response shape (docs/api-reference.md):
 * - New email → create user, send verification email, seal session.
 * - Shadow account (password NULL, no Google) → *claim* it in place: set
 *   password and name, keep the id so booking history carries over.
 * - Full account → enumeration-safe: same `{ ok: true }`, but a
 *   "you already have an account" email is sent instead of creating anything,
 *   and no session is sealed.
 */
export default defineEventHandler(async (event) => {
  const { email, name, password } = await readValidatedBody(event, bodySchema.parse)

  await enforceRateLimit('register:ip', getClientIP(event))

  // Reserved-TLD / anonymised addresses can never verify and must never be
  // claimable — the legacy import created thousands of placeholder rows on
  // them (some owning reservations with other customers' data). Same
  // enumeration-safe response as every other path.
  if (isUndeliverableEmail(email)) {
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
