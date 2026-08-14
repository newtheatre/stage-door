import { db, schema } from '@nuxthub/db'
import { eq } from 'drizzle-orm'
import { z } from 'zod/v4'

const bodySchema = z.object({
  email: emailSchema,
})

/**
 * Request a password reset email. Always `{ ok: true }`; sent iff the account
 * exists, shadow accounts included.
 */
export default defineEventHandler(async (event) => {
  const { email } = await readValidatedBody(event, bodySchema.parse)

  await enforceRateLimit('forgot:ip', getClientIP(event))
  await enforceRateLimit('forgot:acct', email)

  // Undeliverable and Workspace addresses no-op silently: the mail could not
  // arrive, and a reset would undo the domain rule (ADR-0012).
  if (isUndeliverableEmail(email) || isWorkspaceEmail(email)) {
    return { ok: true }
  }

  const user = await db.select().from(schema.users).where(eq(schema.users.email, email)).get()

  if (user && !user.disabled) {
    const token = await createPasswordResetToken(user.id)
    await sendPasswordResetEmail(user.email, token)
  }

  return { ok: true }
})
