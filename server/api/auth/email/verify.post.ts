import { db, schema } from '@nuxthub/db'
import { eq } from 'drizzle-orm'
import { z } from 'zod'

const bodySchema = z.object({
  token: z.string().min(1, 'Verification token is required'),
})

const TOKEN_INVALID = {
  statusCode: 400,
  statusMessage: 'Invalid or expired verification token',
} as const

/**
 * Verify an email address with a token. Single-use, and sends no mail: a new
 * link comes from POST /api/auth/email/request, which is limited per account.
 */
export default defineEventHandler(async (event) => {
  const { token } = await readValidatedBody(event, bodySchema.parse)

  await enforceRateLimit('verify:ip', getClientIP(event))

  const verification = await db.select()
    .from(schema.emailVerifications)
    .where(eq(schema.emailVerifications.token, hashLoginToken(token)))
    .get()

  if (!verification) {
    throw createError(TOKEN_INVALID)
  }

  // The delete is the claim, valid or not: whoever removes the row owns it, so
  // two racing requests cannot both redeem one token.
  const [claimed] = await db.delete(schema.emailVerifications)
    .where(eq(schema.emailVerifications.id, verification.id))
    .returning({ id: schema.emailVerifications.id })

  if (!claimed) {
    throw createError(TOKEN_INVALID)
  }

  if (verification.expiresAt.getTime() < Date.now()) {
    throw createError({
      statusCode: 400,
      statusMessage: 'That verification link has expired: request a new one.',
    })
  }

  const user = await loadUserOr404(verification.userId)

  // The token proves one address. Once the row points somewhere else it proves
  // nothing, and rows minted before the column carry no address at all.
  if (verification.email !== user.email) {
    throw createError(TOKEN_INVALID)
  }

  const [verified] = user.verified
    ? [user]
    : await db.update(schema.users)
        .set({ verified: true })
        .where(eq(schema.users.id, user.id))
        .returning()

  // Re-seal the caller's session with the fresh flag (single-writer rule:
  // this service is the only place that may do this).
  const session = await getUserSession(event)

  // An id match alone re-stamps the current epoch onto a cookie force-logout
  // revoked, undoing it. Same liveness check as requireLiveUser.
  if (session.user?.id === user.id && !livenessFailure(session, user)) {
    await reSealSession(event, verified!, session.loggedInAt)
  }

  return { ok: true }
})
