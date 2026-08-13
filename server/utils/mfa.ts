/**
 * MFA state, recovery codes, and the pending-login handshake (ADR-0012).
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { db, schema } from '@nuxthub/db'
import { and, eq, isNotNull, isNull, lt } from 'drizzle-orm'

type UserRow = typeof schema.users.$inferSelect

/** How long a pending login (password accepted, factor outstanding) lives. */
export const MFA_ATTEMPT_TTL_MS = 5 * 60_000
/** How long a WebAuthn challenge lives. */
export const WEBAUTHN_CHALLENGE_TTL_MS = 2 * 60_000

const RECOVERY_CODE_COUNT = 8

// ── Policy ──────────────────────────────────────────────────────────────────

/**
 * MFA is required of an account, not of a session — which is what keeps the
 * session contract unchanged (docs/session-contract.md).
 *
 * The rule: holds any `:ADMIN` role (active grants only) AND can log in
 * with a password. A Google-only account is exempt because Workspace
 * enforces 2SV upstream; an account with *both* a password and Google is
 * not, because the password is still an attack path.
 */
export async function isMfaRequired(user: UserRow): Promise<boolean> {
  if (user.password === null) return false
  const roles = await loadRoles(user.id)
  return roles.some(role => role.endsWith(':ADMIN'))
}

/** Confirmed factors only — a half-finished enrolment must not gate a login. */
export async function enrolledFactors(userId: string): Promise<('totp' | 'passkey')[]> {
  const factors: ('totp' | 'passkey')[] = []

  const totp = await db.select().from(schema.totpSecrets)
    .where(and(eq(schema.totpSecrets.userId, userId), isNotNull(schema.totpSecrets.confirmedAt)))
    .get()
  if (totp) factors.push('totp')

  const passkey = await db.select().from(schema.webauthnCredentials)
    .where(eq(schema.webauthnCredentials.userId, userId)).get()
  if (passkey) factors.push('passkey')

  return factors
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

/** Consume a pending login. Single-use: the row is deleted on success. */
export async function consumeMfaAttempt(attemptId: string): Promise<UserRow | null> {
  const attempt = await db.select().from(schema.mfaChallenges)
    .where(and(eq(schema.mfaChallenges.id, attemptId), eq(schema.mfaChallenges.kind, 'login')))
    .get()

  if (!attempt?.userId || attempt.expiresAt.getTime() < Date.now()) return null

  await db.delete(schema.mfaChallenges).where(eq(schema.mfaChallenges.id, attemptId))

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
 * Read and consume a WebAuthn challenge. Single-use, and bound to both the
 * kind and (for registration) the account that started it — a challenge is
 * only replay protection if it can't be redirected to another ceremony.
 */
export async function getWebauthnChallenge(
  attemptId: string,
  kind: WebauthnChallengeKind,
  userId: string | null = null,
): Promise<string> {
  const row = await db.select().from(schema.mfaChallenges)
    .where(eq(schema.mfaChallenges.id, attemptId)).get()

  // Single-use, whether or not it turns out to match.
  if (row) await db.delete(schema.mfaChallenges).where(eq(schema.mfaChallenges.id, attemptId))

  if (!row?.challenge
    || row.kind !== kind
    || (userId !== null && row.userId !== userId)
    || row.expiresAt.getTime() < Date.now()) {
    throw createError({ statusCode: 400, statusMessage: 'That took too long — please start again' })
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
  return createHash('sha256').update(code.toLowerCase().replace(/-/g, '')).digest('hex')
}

/** Readable groups, e.g. `k4f9-2xqp-7m3d`. */
function generateRecoveryCode(): string {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789' // no look-alikes
  const bytes = randomBytes(12)
  const chars = Array.from(bytes, b => alphabet[b % alphabet.length]).join('')
  return `${chars.slice(0, 4)}-${chars.slice(4, 8)}-${chars.slice(8, 12)}`
}

/**
 * Replace a user's recovery codes. Plaintext is returned once and never
 * stored — same treatment as service tokens (CLAUDE.md invariant 9 covers
 * *passwords*; these are high-entropy secrets, so SHA-256 is appropriate
 * and 8 scrypt verifications per attempt would be costly on a Worker).
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
      await db.update(schema.mfaRecoveryCodes)
        .set({ usedAt: new Date() })
        .where(eq(schema.mfaRecoveryCodes.id, row.id))
      return true
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

/** Remove every factor — admin reset, and part of erasure. */
export async function clearAllFactors(userId: string): Promise<void> {
  await db.delete(schema.webauthnCredentials).where(eq(schema.webauthnCredentials.userId, userId))
  await db.delete(schema.totpSecrets).where(eq(schema.totpSecrets.userId, userId))
  await db.delete(schema.mfaRecoveryCodes).where(eq(schema.mfaRecoveryCodes.userId, userId))
  await db.delete(schema.mfaChallenges).where(eq(schema.mfaChallenges.userId, userId))
}

/** Passkeys for the account UI — never exposes the public key. */
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
