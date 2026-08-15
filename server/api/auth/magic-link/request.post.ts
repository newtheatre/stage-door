import { db, schema } from '@nuxthub/db'
import { eq } from 'drizzle-orm'
import { z } from 'zod/v4'

const bodySchema = z.object({
  email: emailSchema,
  // Rides through the email into the link, validated at consumption — the
  // request endpoint never acts on it.
  redirect: z.string().max(500).optional(),
})

/**
 * Email a sign-in link (ADR-0013). Always `{ ok: true }`; sent iff the account
 * exists and is not disabled, shadow accounts included.
 */
export default defineEventHandler(async (event) => {
  const { email, redirect } = await readValidatedBody(event, bodySchema.parse)

  await enforceRateLimit('magic:ip', getClientIP(event))
  await enforceRateLimit('magic:acct', email)

  // Same deliberate exception as password login (ADR-0012): a magic link is
  // a login entry point, and Workspace addresses always sign in with Google.
  if (isWorkspaceEmail(email)) {
    throw createError({
      statusCode: 403,
      statusMessage: 'NNT accounts sign in with Google. Use the "Sign in with Google" button instead.',
      data: { useGoogle: true },
    })
  }

  // Anonymised/placeholder addresses could never receive the mail.
  if (isUndeliverableEmail(email)) {
    return { ok: true }
  }

  const user = await db.select().from(schema.users).where(eq(schema.users.email, email)).get()

  if (user && !user.disabled) {
    const token = await createMagicLinkToken(user.id)
    await sendMagicLinkEmail(user.email, token, redirect)
  }

  return { ok: true }
})
