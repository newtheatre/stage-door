import { db, schema } from '@nuxthub/db'
import { eq } from 'drizzle-orm'
import { z } from 'zod/v4'

const bodySchema = z.object({
  email: emailSchema,
  password: z.string().min(1, 'Password is required'),
})

const INVALID_CREDENTIALS = {
  statusCode: 401,
  statusMessage: 'Invalid email or password',
} as const

/**
 * Authenticate with email and password. Unknown user, wrong password,
 * password-less account and disabled account all give the same 401.
 */
export default defineEventHandler(async (event) => {
  const { email, password } = await readValidatedBody(event, bodySchema.parse)

  // Different keys, so nothing is gained by doing them one after the other.
  await Promise.all([
    enforceRateLimit('login:ip', getClientIP(event)),
    enforceRateLimit('login:acct', email),
  ])

  // The one deliberate exception to enumeration-safe errors: the domain policy
  // is a public fact about the address, not about whether an account exists.
  if (isWorkspaceEmail(email)) {
    throw createError({
      statusCode: 403,
      statusMessage: 'NNT accounts sign in with Google. Use the "Sign in with Google" button below.',
      data: { useGoogle: true },
    })
  }

  const user = await db.select().from(schema.users).where(eq(schema.users.email, email)).get()

  const validPassword = await verifyPasswordGuarded(user?.password ?? null, password)

  if (!user || !validPassword || user.disabled) {
    throw createError(INVALID_CREDENTIALS)
  }

  // Enrolled factors gate the session. A required-but-unenrolled admin still
  // gets one: requireAuthAdmin holds the line instead (ADR-0012).
  const challenge = await sealOrChallenge(event, user)
  if (challenge) return challenge

  const { user: sessionUser } = await getUserSession(event)

  return {
    user: sessionUser,
    // The sealed session already holds the effective roles: this is the
    // hottest path in the estate and must not re-run the eligibility query.
    ...(await isMfaRequired(user, sessionUser?.roles) ? { mfaEnrolmentRequired: true } : {}),
  }
})
