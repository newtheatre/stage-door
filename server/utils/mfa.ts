/**
 * MFA state, recovery codes, and the pending-login handshake (ADR-0012).
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { db, schema } from '@nuxthub/db'
import { and, eq, isNull, lt, sql } from 'drizzle-orm'

type UserRow = typeof schema.users.$inferSelect

/** How long a pending login (password accepted, factor outstanding) lives. */
export const MFA_ATTEMPT_TTL_MS = 5 * 60_000
/** How long a WebAuthn challenge lives. */
export const WEBAUTHN_CHALLENGE_TTL_MS = 2 * 60_000

const RECOVERY_CODE_COUNT = 8

// ── Policy ──────────────────────────────────────────────────────────────────

/**
 * MFA is required of an account, not a session, which is what keeps the
 * session contract unchanged. The rule: docs/security.md#mfa
 */
export async function isMfaRequired(user: UserRow, roles?: string[]): Promise<boolean> {
  if (user.password === null) return false
  // Callers that already hold the roles pass them: a guard should not re-read
  // what it just read.
  const held = roles ?? await loadRoles(user.id)
  return held.some(role => role.endsWith(':ADMIN'))
}

/** Confirmed factors only: a half-finished enrolment must not gate a login. */
export async function enrolledFactors(userId: string): Promise<('totp' | 'passkey')[]> {
  // One round trip: this runs on every admin request, before the handler.
  const row = await db.select({
    totp: sql<number>`exists (select 1 from ${schema.totpSecrets} where ${schema.totpSecrets.userId} = ${userId} and ${schema.totpSecrets.confirmedAt} is not null)`,
    passkey: sql<number>`exists (select 1 from ${schema.webauthnCredentials} where ${schema.webauthnCredentials.userId} = ${userId})`,
  }).from(sql`(select 1)`).get()

  const factors: ('totp' | 'passkey')[] = []
  if (row?.totp) factors.push('totp')
  if (row?.passkey) factors.push('passkey')
  return factors
}

/**
 * The single seam between "credentials proven" and "session exists"
 * (ADR-0013). Bypassing it anywhere is an MFA bypass.
 */
export async function sealOrChallenge(event: Parameters<typeof sealLoginSession>[0], user: UserRow): Promise<
  { mfaRequired: true, attemptId: string, methods: ('totp' | 'passkey')[] } | null
> {
  const factors = await enrolledFactors(user.id)
  if (factors.length > 0) {
    return {
      mfaRequired: true,
      attemptId: await createMfaAttempt(user.id),
      methods: factors,
    }
  }
  await sealLoginSession(event, user)
  return null
}

// ── Pending logins & challenges ─────────────────────────────────────────────

/** Create the opaque handle returned to a client that passed the password. */
export async function createMfaAttempt(userId: string): Promise<string> {
  const id = randomBytes(32).toString('base64url')
  await db.insert(schema.mfaChallenges).values({
    id,
    userId,
    kind: 'login',
    expiresAt: new Date(Date.now() + MFA_ATTEMPT_TTL_MS),
  })
  return id
}

/**
 * Consume a pending login. The delete is the claim, so two racing requests
 * cannot both act on one attempt.
 */
export async function consumeMfaAttempt(attemptId: string): Promise<UserRow | null> {
  const [attempt] = await db.delete(schema.mfaChallenges)
    .where(and(eq(schema.mfaChallenges.id, attemptId), eq(schema.mfaChallenges.kind, 'login')))
    .returning()

  if (!attempt?.userId || attempt.expiresAt.getTime() < Date.now()) return null

  const user = await db.select().from(schema.users).where(eq(schema.users.id, attempt.userId)).get()
  return user && !user.disabled ? user : null
}

export type WebauthnChallengeKind = 'webauthn-register' | 'webauthn-authenticate'

export async function storeWebauthnChallenge(
  attemptId: string,
  challenge: string,
  kind: WebauthnChallengeKind,
  userId: string | null,
): Promise<void> {
  await db.insert(schema.mfaChallenges).values({
    id: attemptId,
    userId,
    kind,
    challenge,
    expiresAt: new Date(Date.now() + WEBAUTHN_CHALLENGE_TTL_MS),
  })
}

/**
 * Single-use, and bound to the kind and account that started it: a
 * challenge is only replay protection if it cannot be redirected.
 */
export async function getWebauthnChallenge(
  attemptId: string,
  kind: WebauthnChallengeKind,
  userId: string | null = null,
): Promise<string> {
  // Deleted as it is read, whether or not it turns out to match: the delete
  // is what makes it single-use.
  const [row] = await db.delete(schema.mfaChallenges)
    .where(eq(schema.mfaChallenges.id, attemptId)).returning()

  if (!row?.challenge
    || row.kind !== kind
    || (userId !== null && row.userId !== userId)
    || row.expiresAt.getTime() < Date.now()) {
    throw createError({ statusCode: 400, statusMessage: 'That took too long: please start again' })
  }

  return row.challenge
}

/** Housekeeping for the nightly sweep. */
export async function sweepMfaChallenges(): Promise<number> {
  const removed = await db.delete(schema.mfaChallenges)
    .where(lt(schema.mfaChallenges.expiresAt, new Date()))
    .returning({ id: schema.mfaChallenges.id })
  return removed.length
}

// ── Recovery codes ──────────────────────────────────────────────────────────

function hashRecoveryCode(code: string): string {
  // Case, dashes, and whitespace are all forgiven: these get read off a
  // screen or pasted from the downloaded .txt, stray characters included.
  return createHash('sha256').update(code.toLowerCase().replace(/[-\s]/g, '')).digest('hex')
}

/** Readable groups, e.g. `k4f9-2xqp-7m3d`. */
function generateRecoveryCode(): string {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789' // no look-alikes
  const bytes = randomBytes(12)
  const chars = Array.from(bytes, b => alphabet[b % alphabet.length]).join('')
  return `${chars.slice(0, 4)}-${chars.slice(4, 8)}-${chars.slice(8, 12)}`
}

/**
 * Plaintext returned once, never stored. SHA-256 rather than scrypt: these
 * are high-entropy, and 8 verifications per attempt would be costly.
 */
export async function regenerateRecoveryCodes(userId: string): Promise<string[]> {
  await db.delete(schema.mfaRecoveryCodes).where(eq(schema.mfaRecoveryCodes.userId, userId))

  const codes = Array.from({ length: RECOVERY_CODE_COUNT }, generateRecoveryCode)
  for (const code of codes) {
    await db.insert(schema.mfaRecoveryCodes).values({ userId, codeHash: hashRecoveryCode(code) })
  }
  return codes
}

/** Verify and consume one unused recovery code. Constant-time per candidate. */
export async function useRecoveryCode(userId: string, submitted: string): Promise<boolean> {
  const candidate = Buffer.from(hashRecoveryCode(submitted))

  const rows = await db.select().from(schema.mfaRecoveryCodes)
    .where(and(eq(schema.mfaRecoveryCodes.userId, userId), isNull(schema.mfaRecoveryCodes.usedAt)))
    .all()

  for (const row of rows) {
    const stored = Buffer.from(row.codeHash)
    if (stored.length === candidate.length && timingSafeEqual(stored, candidate)) {
      // is-null in the predicate, and the row count is the answer: a bare
      // id match lets two racing requests spend the same code.
      const claimed = await db.update(schema.mfaRecoveryCodes)
        .set({ usedAt: new Date() })
        .where(and(eq(schema.mfaRecoveryCodes.id, row.id), isNull(schema.mfaRecoveryCodes.usedAt)))
        .returning({ id: schema.mfaRecoveryCodes.id })
      return claimed.length > 0
    }
  }
  return false
}

export async function remainingRecoveryCodes(userId: string): Promise<number> {
  const rows = await db.select().from(schema.mfaRecoveryCodes)
    .where(and(eq(schema.mfaRecoveryCodes.userId, userId), isNull(schema.mfaRecoveryCodes.usedAt)))
    .all()
  return rows.length
}

/** Remove every factor: admin reset, and part of erasure. */
export async function clearAllFactors(userId: string): Promise<void> {
  await db.delete(schema.webauthnCredentials).where(eq(schema.webauthnCredentials.userId, userId))
  await db.delete(schema.totpSecrets).where(eq(schema.totpSecrets.userId, userId))
  await db.delete(schema.mfaRecoveryCodes).where(eq(schema.mfaRecoveryCodes.userId, userId))
  await db.delete(schema.mfaChallenges).where(eq(schema.mfaChallenges.userId, userId))
}

/** Passkeys for the account UI: never exposes the public key. */
export async function listPasskeys(userId: string) {
  const rows = await db.select().from(schema.webauthnCredentials)
    .where(eq(schema.webauthnCredentials.userId, userId)).all()
  return rows.map(r => ({
    id: r.id,
    name: r.name,
    createdAt: r.createdAt.getTime(),
    lastUsedAt: r.lastUsedAt?.getTime() ?? null,
    backedUp: r.backedUp,
  }))
}
