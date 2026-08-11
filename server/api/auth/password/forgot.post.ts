import { db, schema } from '@nuxthub/db'
import { eq } from 'drizzle-orm'
import { z } from 'zod/v4'

const bodySchema = z.object({
  email: emailSchema,
})

/**
 * POST /api/auth/password/forgot — request a password reset email.
 *
 * Always `{ ok: true }` (enumeration-safe). The email is sent iff the
 * account exists — including shadow accounts: this is the account-claiming
 * path advertised in booking confirmations (docs/api-reference.md).
 */
export default defineEventHandler(async (event) => {
  const { email } = await readValidatedBody(event, bodySchema.parse)

  await enforceRateLimit('forgot:ip', getClientIP(event))
  await enforceRateLimit('forgot:acct', email)

  const user = await db.select().from(schema.users).where(eq(schema.users.email, email)).get()

  if (user && !user.disabled) {
    const token = await createPasswordResetToken(user.id)
    await sendPasswordResetEmail(user.email, token)
  }

  return { ok: true }
})
