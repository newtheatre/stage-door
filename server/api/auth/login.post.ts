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

  const user = await db.select().from(schema.users).where(eq(schema.users.email, email)).get()

  const validPassword = await verifyPasswordGuarded(user?.password ?? null, password)

  if (!user || !validPassword || user.disabled) {
    throw createError(INVALID_CREDENTIALS)
  }

  await sealLoginSession(event, user)
  const { user: sessionUser } = await getUserSession(event)

  return { user: sessionUser }
})
