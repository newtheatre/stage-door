import { createHash, randomBytes } from 'node:crypto'
import { db, schema } from '@nuxthub/db'
import { eq } from 'drizzle-orm'

/** Token expiry durations in milliseconds (ported from Proscenium). */
export const TOKEN_EXPIRY = {
  /** Email verification tokens are valid for 24 hours. */
  EMAIL_VERIFICATION: 24 * 60 * 60 * 1000,
  /** Password reset tokens are valid for 1 hour. */
  PASSWORD_RESET: 1 * 60 * 60 * 1000,
  /** Admin-initiated password reset tokens are valid for 24 hours. */
  ADMIN_PASSWORD_RESET: 24 * 60 * 60 * 1000,
  /** Magic sign-in links are valid for 15 minutes (ADR-0013). */
  MAGIC_LINK: 15 * 60 * 1000,
} as const

/** Generate a cryptographically secure random token (32 bytes, hex). */
export function generateVerificationToken(): string {
  return randomBytes(32).toString('hex')
}

/**
 * SHA-256 for emailed tokens at rest (ADR-0013). A database leak must not
 * hand out live login links.
 */
export function hashLoginToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/**
 * Bound to the address it is mailed to, not just the account: an outstanding
 * token must not verify whatever address the row is pointed at later.
 */
export async function createEmailVerificationToken(userId: string, email: string): Promise<string> {
  const token = generateVerificationToken()
  const expiresAt = new Date(Date.now() + TOKEN_EXPIRY.EMAIL_VERIFICATION)

  await db.delete(schema.emailVerifications).where(eq(schema.emailVerifications.userId, userId))

  await db.insert(schema.emailVerifications).values({
    userId,
    email,
    token: hashLoginToken(token),
    expiresAt,
  })

  return token
}

/**
 * One outstanding reset token per user, so this deletes any existing ones
 * first. Returns the token; the hash is what gets stored.
 */
export async function createPasswordResetToken(
  userId: string,
  expiry: number = TOKEN_EXPIRY.PASSWORD_RESET,
): Promise<string> {
  const token = generateVerificationToken()
  const expiresAt = new Date(Date.now() + expiry)

  await db.delete(schema.passwordResets).where(eq(schema.passwordResets.userId, userId))

  await db.insert(schema.passwordResets).values({
    userId,
    token: hashLoginToken(token),
    expiresAt,
  })

  return token
}

/**
 * Magic sign-in link (ADR-0013). One outstanding token per user, like
 * password resets.
 */
export async function createMagicLinkToken(userId: string): Promise<string> {
  const token = generateVerificationToken()
  const expiresAt = new Date(Date.now() + TOKEN_EXPIRY.MAGIC_LINK)

  await db.delete(schema.magicLinks).where(eq(schema.magicLinks.userId, userId))

  await db.insert(schema.magicLinks).values({
    userId,
    tokenHash: hashLoginToken(token),
    expiresAt,
  })

  return token
}
