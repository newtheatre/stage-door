import { db, schema } from '@nuxthub/db'
import { eq } from 'drizzle-orm'
import { z } from 'zod/v4'

const bodySchema = z.object({
  token: z.string().min(1, 'Token is required'),
})

const LINK_INVALID = {
  statusCode: 400,
  statusMessage: 'That sign-in link has expired or already been used — request a new one',
} as const

/**
 * Exchange an emailed link for a session (ADR-0013). Single-use.
 * The MFA seam applies exactly as at login.
 */
export default defineEventHandler(async (event) => {
  const { token } = await readValidatedBody(event, bodySchema.parse)

  await enforceRateLimit('magic:ip', getClientIP(event))

  const link = await db.select().from(schema.magicLinks)
    .where(eq(schema.magicLinks.tokenHash, hashLoginToken(token)))
    .get()

  if (!link) throw createError(LINK_INVALID)

  // The delete is the claim, valid or not: whoever removes the row owns it,
  // so two racing requests cannot both redeem one link.
  const [claimed] = await db.delete(schema.magicLinks)
    .where(eq(schema.magicLinks.id, link.id)).returning({ id: schema.magicLinks.id })
  if (!claimed) throw createError(LINK_INVALID)

  if (link.expiresAt.getTime() < Date.now()) throw createError(LINK_INVALID)

  const user = await db.select().from(schema.users).where(eq(schema.users.id, link.userId)).get()

  // Disabled accounts get the same generic error — indistinguishable from
  // an expired link by design.
  if (!user || user.disabled) throw createError(LINK_INVALID)

  if (!user.verified) {
    await db.update(schema.users).set({ verified: true }).where(eq(schema.users.id, user.id))
    user.verified = true
  }

  const challenge = await sealOrChallenge(event, user)
  if (challenge) return challenge

  const { user: sessionUser } = await getUserSession(event)
  return { user: sessionUser }
})
