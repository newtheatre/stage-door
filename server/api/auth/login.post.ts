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
 * POST /api/auth/login — authenticate with email and password.
 *
 * Unknown user, wrong password, password-less (guest/SSO-only) account, and
 * disabled account all produce this same 401 — indistinguishable by design
 * (docs/api-reference.md).
 */
export default defineEventHandler(async (event) => {
  const { email, password } = await readValidatedBody(event, bodySchema.parse)

  await enforceRateLimit('login:ip', getClientIP(event))
  await enforceRateLimit('login:acct', email)

  // NNT Workspace addresses always sign in with Google (ADR-0012), which
  // brings Google's enforced 2SV with it. This is the one deliberate
  // exception to enumeration-safe login errors: the domain policy is a
  // public fact about the *address*, not a fact about whether an account
  // exists — and a generic "invalid email or password" here would strand
  // committee members with no idea why their password stopped working.
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

  // Second factor (ADR-0012). Enrolled factors gate the session: the
  // password is accepted but nothing is sealed until the factor is proven.
  const factors = await enrolledFactors(user.id)
  if (factors.length > 0) {
    return {
      mfaRequired: true,
      attemptId: await createMfaAttempt(user.id),
      methods: factors,
    }
  }

  // Required but not yet enrolled: seal the session anyway — they gave the
  // right password, and locking the ITM out of their own account is worse
  // than the gap. requireAuthAdmin refuses admin work until they enrol.
  await sealLoginSession(event, user)
  const { user: sessionUser } = await getUserSession(event)

  return {
    user: sessionUser,
    ...(await isMfaRequired(user) ? { mfaEnrolmentRequired: true } : {}),
  }
})
