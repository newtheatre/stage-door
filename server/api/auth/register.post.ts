import { db, schema } from '@nuxthub/db'
import { eq } from 'drizzle-orm'
import { z } from 'zod'

const bodySchema = z.object({
  email: emailSchema,
  name: z.string().min(1, 'Name is required').max(200),
  password: passwordSchema,
})

/**
 * Create an account, or email a set-password link for an existing claimable
 * one. Never seals a session: the mailbox is the proof (ADR-0022).
 */
export default defineEventHandler(async (event) => {
  const { email, name, password } = await readValidatedBody(event, bodySchema.parse)

  await enforceRateLimit('register:ip', getClientIP(event))
  await enforceRateLimit('register:acct', email)

  // Reserved-TLD addresses can never verify and must never be claimable;
  // Workspace addresses get their account from Google (ADR-0012).
  if (isUndeliverableEmail(email) || isWorkspaceEmail(email)) {
    return { ok: true }
  }

  // Unconditional, so scrypt costs the same whether or not the account exists.
  const hashedPassword = await hashPassword(password)

  const existing = await db.select().from(schema.users).where(eq(schema.users.email, email)).get()

  if (existing) {
    const claimable = existing.password === null && existing.googleSub === null

    if (!claimable) {
      await sendAccountExistsEmail(email)
    }
    else if (!existing.disabled) {
      // Same token an admin-created account gets: it sets the password, and
      // reset.post.ts already checks `disabled` and routes through the seam.
      const claimToken = await createPasswordResetToken(existing.id, TOKEN_EXPIRY.ADMIN_PASSWORD_RESET)
      await sendPasswordResetEmail(email, claimToken)
    }

    return { ok: true }
  }

  const [user] = await db.insert(schema.users).values({
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

  return { ok: true }
})
