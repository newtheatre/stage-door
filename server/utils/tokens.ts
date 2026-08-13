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
 * SHA-256 for emailed tokens at rest (ADR-0013). These are high-entropy
 * secrets like service tokens and recovery codes, so the same treatment
 * applies — a database leak must not hand out live login links. (CLAUDE.md
 * invariant 9's scrypt rule is scoped to passwords.)
 */
export function hashLoginToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/**
 * Create and persist an email verification token for a user.
 *
 * @returns The generated token string (the hash is what's stored).
 */
export async function createEmailVerificationToken(userId: string): Promise<string> {
  const token = generateVerificationToken()
  const expiresAt = new Date(Date.now() + TOKEN_EXPIRY.EMAIL_VERIFICATION)

  await db.insert(schema.emailVerifications).values({
    userId,
    token: hashLoginToken(token),
    expiresAt,
  })

  return token
}

/**
 * Create and persist a password reset token for a user.
 * Deletes any existing reset tokens for the user first (single outstanding
 * token per user).
 *
 * @param userId  The user to create a reset token for.
 * @param expiry  Token lifetime in ms (defaults to PASSWORD_RESET — 1 hour).
 * @returns The generated token string (the hash is what's stored).
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
 * Create and persist a magic sign-in link token (ADR-0013). Single
 * outstanding token per user, like password resets.
 *
 * @returns The generated token string (the hash is what's stored).
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
