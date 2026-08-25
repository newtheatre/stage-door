import { describe, expect, it } from 'bun:test'
import { db, schema } from '@nuxthub/db'
import { eq } from 'drizzle-orm'
import loginHandler from '../server/api/auth/login.post'
import verifyHandler from '../server/api/auth/mfa/verify.post'
import totpStartHandler from '../server/api/account/mfa/totp.post'
import totpConfirmHandler from '../server/api/account/mfa/totp-confirm.post'
import removeFactorHandler from '../server/api/account/mfa/[id].delete'
import changeOwnPasswordHandler from '../server/api/account/password.put'
import changeOwnProfileHandler from '../server/api/account/profile.put'
import mfaResetHandler from '../server/api/users/[id]/mfa-reset.post'
import rolesHandler from '../server/api/users/[id]/roles.put'
import { totpCode } from '../server/utils/totp'
import {
  isMfaRequired,
  enrolledFactors,
  createMfaAttempt,
  consumeMfaAttempt,
  storeWebauthnChallenge,
  getWebauthnChallenge,
  sweepMfaChallenges,
  regenerateRecoveryCodes,
  useRecoveryCode,
  remainingRecoveryCodes,
  clearAllFactors,
} from '../server/utils/mfa'
import { makeEvent, sealedSession, type FakeEvent } from './setup'
import { createUser, grantRole, enrolTotp } from './helpers/users'

const login = loginHandler as unknown as (event: unknown) => Promise<Record<string, unknown>>
const verify = verifyHandler as unknown as (event: unknown) => Promise<Record<string, unknown>>
const startTotp = totpStartHandler as unknown as (event: unknown) => Promise<{ secret: string, uri: string }>
const confirmTotp = totpConfirmHandler as unknown as (event: unknown) => Promise<{ recoveryCodes: string[] | null }>
const removeFactor = removeFactorHandler as unknown as (event: unknown) => Promise<unknown>
const changeOwnPassword = changeOwnPasswordHandler as unknown as (event: unknown) => Promise<unknown>
const changeOwnProfile = changeOwnProfileHandler as unknown as (event: unknown) => Promise<unknown>
const mfaReset = mfaResetHandler as unknown as (event: unknown) => Promise<unknown>
const putRoles = rolesHandler as unknown as (event: unknown) => Promise<unknown>

const SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'

/** An event carrying a live session for `user` (as the account guard reads it). */
async function sessionEvent(user: { id: string, email: string, name: string, sessionEpoch: number }, extra: Partial<FakeEvent> = {}) {
  const event = makeEvent(extra)
  await (globalThis as never as { setUserSession: (e: unknown, s: unknown) => Promise<unknown> })
    .setUserSession(event, {
      user: { id: user.id, email: user.email, name: user.name, verified: true, guest: false, roles: [] },
      loggedInAt: Date.now(),
      refreshedAt: Date.now(),
      epoch: user.sessionEpoch,
    })
  return event
}

async function caught(fn: () => Promise<unknown>) {
  try {
    await fn()
    return undefined
  }
  catch (error) {
    return error as { statusCode: number, statusMessage: string, data?: Record<string, unknown> }
  }
}

describe('who MFA is required of', () => {
  it('is a property of the account: an admin who can use a password', async () => {
    const user = await createUser({ email: 'admin@example.com', plainPassword: 'Passw0rd' })
    await grantRole(user.id, 'rooms:ADMIN')
    expect(await isMfaRequired(user)).toBe(true)
  })

  it('exempts a Google-only admin: Workspace enforces 2SV upstream', async () => {
    const user = await createUser({ email: 'sso@example.com', googleSub: 'g-1' })
    await grantRole(user.id, 'auth:ADMIN')
    expect(await isMfaRequired(user)).toBe(false)
  })

  it('does not require it of a non-admin role holder', async () => {
    const user = await createUser({ email: 'box@example.com', plainPassword: 'Passw0rd' })
    await grantRole(user.id, 'proscenium:BOX_OFFICE')
    expect(await isMfaRequired(user)).toBe(false)
  })

  it('stops requiring it once the admin grant expires (ADR-0011)', async () => {
    const user = await createUser({ email: 'past@example.com', plainPassword: 'Passw0rd' })
    await grantRole(user.id, 'rooms:ADMIN', { expiresAt: new Date(Date.now() - 1000) })
    expect(await isMfaRequired(user)).toBe(false)
  })

  it('counts only confirmed factors as enrolled', async () => {
    const user = await createUser({ email: 'half@example.com', plainPassword: 'Passw0rd' })
    await db.insert(schema.totpSecrets).values({ userId: user.id, secret: SECRET })
    expect(await enrolledFactors(user.id)).toEqual([])

    await db.update(schema.totpSecrets).set({ confirmedAt: new Date() })
      .where(eq(schema.totpSecrets.userId, user.id))
    expect(await enrolledFactors(user.id)).toEqual(['totp'])
  })
})

describe('login with a second factor', () => {
  it('withholds the session and hands back an attempt', async () => {
    const user = await createUser({ email: 'enrolled@example.com', plainPassword: 'Passw0rd', verified: true })
    await enrolTotp(user.id, SECRET)

    const event = makeEvent({ body: { email: 'enrolled@example.com', password: 'Passw0rd' } })
    const result = await login(event)

    expect(result.mfaRequired).toBe(true)
    expect(result.methods).toEqual(['totp'])
    expect(typeof result.attemptId).toBe('string')
    // Nothing sealed: the password alone gets you nowhere.
    expect(sealedSession(event)).toBeUndefined()
  })

  it('lets a required-but-unenrolled admin in, and flags the enrolment', async () => {
    const user = await createUser({ email: 'itm@example.com', plainPassword: 'Passw0rd', verified: true })
    await grantRole(user.id, 'auth:ADMIN')

    const event = makeEvent({ body: { email: 'itm@example.com', password: 'Passw0rd' } })
    const result = await login(event)

    expect(result.mfaEnrolmentRequired).toBe(true)
    expect(sealedSession(event)).toBeDefined()
  })

  it('but the admin guard refuses their admin work until they enrol', async () => {
    const admin = await createUser({ email: 'unenrolled-admin@example.com', plainPassword: 'Passw0rd', verified: true })
    await grantRole(admin.id, 'auth:ADMIN')
    const subject = await createUser({ email: 'subject@example.com' })

    const event = await sessionEvent(admin, { params: { id: subject.id }, body: { roles: ['rooms:ADMIN'] } })
    ;(await (globalThis as never as { getUserSession: (e: unknown) => Promise<{ user: { roles: string[] } }> })
      .getUserSession(event)).user.roles.push('auth:ADMIN')

    const error = await caught(() => putRoles(event))
    expect(error?.statusCode).toBe(403)
    expect(error?.data).toMatchObject({ mfaEnrolmentRequired: true })
  })

  it('leaves an account with no factors and no admin role completely alone', async () => {
    await createUser({ email: 'ordinary@example.com', plainPassword: 'Passw0rd', verified: true })
    const event = makeEvent({ body: { email: 'ordinary@example.com', password: 'Passw0rd' } })
    const result = await login(event)

    expect(result.mfaRequired).toBeUndefined()
    expect(result.mfaEnrolmentRequired).toBeUndefined()
    expect(sealedSession(event)).toBeDefined()
  })
})

describe('POST /api/auth/mfa/verify', () => {
  async function pendingLogin() {
    const user = await createUser({ email: 'verify@example.com', plainPassword: 'Passw0rd', verified: true })
    await enrolTotp(user.id, SECRET)
    const attemptId = await createMfaAttempt(user.id)
    return { user, attemptId }
  }

  it('seals the session for a correct code', async () => {
    const { user, attemptId } = await pendingLogin()
    const event = makeEvent({ body: { attemptId, code: await totpCode(SECRET) } })

    const result = await verify(event)
    expect((result.user as { id: string }).id).toBe(user.id)
    expect(sealedSession(event)).toBeDefined()
  })

  it('rejects a wrong code, burns the attempt, and re-issues one', async () => {
    const { attemptId } = await pendingLogin()
    const error = await caught(() => verify(makeEvent({ body: { attemptId, code: '000000' } })))

    expect(error?.statusCode).toBe(401)
    const reissued = error?.data?.attemptId as string
    expect(reissued).toBeTruthy()
    expect(reissued).not.toBe(attemptId)

    // The burnt attempt is gone; the new one works.
    expect(await consumeMfaAttempt(attemptId)).toBeNull()
    expect(await consumeMfaAttempt(reissued)).not.toBeNull()
  })

  it('will not replay a code inside its own window', async () => {
    const { attemptId, user } = await pendingLogin()
    const code = await totpCode(SECRET)
    await verify(makeEvent({ body: { attemptId, code } }))

    const second = await createMfaAttempt(user.id)
    const error = await caught(() => verify(makeEvent({ body: { attemptId: second, code } })))
    expect(error?.statusCode).toBe(401)
  })

  it('accepts a recovery code exactly once, and audits it', async () => {
    const { user, attemptId } = await pendingLogin()
    const [code] = await regenerateRecoveryCodes(user.id)

    const result = await verify(makeEvent({ body: { attemptId, code: code! } }))
    expect(result.usedRecoveryCode).toBe(true)
    expect(await remainingRecoveryCodes(user.id)).toBe(7)

    const audit = await db.select().from(schema.auditLog)
      .where(eq(schema.auditLog.action, 'mfa.recovery-code-used')).all()
    expect(audit).toHaveLength(1)

    const again = await createMfaAttempt(user.id)
    const error = await caught(() => verify(makeEvent({ body: { attemptId: again, code: code! } })))
    expect(error?.statusCode).toBe(401)
  })

  it('refuses an expired or unknown attempt', async () => {
    const { user } = await pendingLogin()
    const stale = await createMfaAttempt(user.id)
    await db.update(schema.mfaChallenges)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(schema.mfaChallenges.id, stale))

    expect((await caught(() => verify(makeEvent({ body: { attemptId: stale, code: '000000' } }))))?.statusCode).toBe(400)
    expect((await caught(() => verify(makeEvent({ body: { attemptId: 'made-up', code: '000000' } }))))?.statusCode).toBe(400)
  })

  it('refuses an attempt belonging to an account disabled since the password step', async () => {
    const { user, attemptId } = await pendingLogin()
    await db.update(schema.users).set({ disabled: true }).where(eq(schema.users.id, user.id))

    const code = await totpCode(SECRET)
    expect((await caught(() => verify(makeEvent({ body: { attemptId, code } }))))?.statusCode).toBe(400)
  })
})

describe('recovery codes', () => {
  it('are stored hashed, never in the clear', async () => {
    const user = await createUser({ email: 'codes@example.com' })
    const codes = await regenerateRecoveryCodes(user.id)

    const rows = await db.select().from(schema.mfaRecoveryCodes)
      .where(eq(schema.mfaRecoveryCodes.userId, user.id)).all()

    expect(rows).toHaveLength(8)
    for (const row of rows) {
      expect(row.codeHash).toMatch(/^[a-f0-9]{64}$/)
      expect(codes).not.toContain(row.codeHash)
    }
  })

  it('ignore case and dashes, since they get read off a screen', async () => {
    const user = await createUser({ email: 'typed@example.com' })
    const [code] = await regenerateRecoveryCodes(user.id)
    expect(await useRecoveryCode(user.id, code!.toUpperCase().replace(/-/g, ''))).toBe(true)
  })

  it('are replaced wholesale on regeneration', async () => {
    const user = await createUser({ email: 'rotate@example.com' })
    const [old] = await regenerateRecoveryCodes(user.id)
    await regenerateRecoveryCodes(user.id)

    expect(await useRecoveryCode(user.id, old!)).toBe(false)
    expect(await remainingRecoveryCodes(user.id)).toBe(8)
  })

  it('belong to one account only', async () => {
    const owner = await createUser({ email: 'owner@example.com' })
    const other = await createUser({ email: 'other@example.com' })
    const [code] = await regenerateRecoveryCodes(owner.id)

    expect(await useRecoveryCode(other.id, code!)).toBe(false)
  })
})

describe('WebAuthn challenge storage', () => {
  it('is single-use and bound to its ceremony and account', async () => {
    const user = await createUser({ email: 'passkey@example.com' })

    await storeWebauthnChallenge('attempt-1', 'chal-1', 'webauthn-register', user.id)
    expect(await getWebauthnChallenge('attempt-1', 'webauthn-register', user.id)).toBe('chal-1')
    // Consumed.
    await expect(getWebauthnChallenge('attempt-1', 'webauthn-register', user.id)).rejects.toMatchObject({ statusCode: 400 })

    // A registration challenge can't be spent on an authentication.
    await storeWebauthnChallenge('attempt-2', 'chal-2', 'webauthn-register', user.id)
    await expect(getWebauthnChallenge('attempt-2', 'webauthn-authenticate')).rejects.toMatchObject({ statusCode: 400 })

    // Nor by a different account.
    const intruder = await createUser({ email: 'intruder@example.com' })
    await storeWebauthnChallenge('attempt-3', 'chal-3', 'webauthn-register', user.id)
    await expect(getWebauthnChallenge('attempt-3', 'webauthn-register', intruder.id)).rejects.toMatchObject({ statusCode: 400 })
  })

  it('expires, and the sweep clears what is left behind', async () => {
    const user = await createUser({ email: 'sweep@example.com' })
    await storeWebauthnChallenge('old', 'chal', 'webauthn-authenticate', null)
    await createMfaAttempt(user.id)
    await db.update(schema.mfaChallenges).set({ expiresAt: new Date(Date.now() - 1000) })

    await expect(getWebauthnChallenge('old', 'webauthn-authenticate')).rejects.toMatchObject({ statusCode: 400 })
    expect(await sweepMfaChallenges()).toBe(1) // the attempt; 'old' went on read
    expect(await sweepMfaChallenges()).toBe(0)
  })
})

describe('managing your own factors', () => {
  it('enrols TOTP: unconfirmed changes nothing, confirming issues recovery codes and bumps the epoch', async () => {
    const user = await createUser({ email: 'enrol@example.com', plainPassword: 'Passw0rd', verified: true })

    const setup = await startTotp(await sessionEvent(user))
    expect(setup.uri).toContain(setup.secret)
    expect(await enrolledFactors(user.id)).toEqual([])

    const confirm = await sessionEvent(user, { body: { code: await totpCode(setup.secret) } })
    const { recoveryCodes } = await confirmTotp(confirm)

    expect(recoveryCodes).toHaveLength(8)
    expect(await enrolledFactors(user.id)).toEqual(['totp'])

    const after = await db.select().from(schema.users).where(eq(schema.users.id, user.id)).get()
    expect(after?.sessionEpoch).toBe(1)
    // This session survives the bump; the others don't.
    expect(sealedSession(confirm)).toMatchObject({ epoch: 1 })
  })

  it('refuses a wrong confirmation code', async () => {
    const user = await createUser({ email: 'wrong@example.com', plainPassword: 'Passw0rd' })
    await startTotp(await sessionEvent(user))

    const error = await caught(async () => confirmTotp(await sessionEvent(user, { body: { code: '000000' } })))
    expect(error?.statusCode).toBe(400)
    expect(await enrolledFactors(user.id)).toEqual([])
  })

  it('will not let a required account remove its last factor', async () => {
    const user = await createUser({ email: 'last@example.com', plainPassword: 'Passw0rd' })
    await grantRole(user.id, 'auth:ADMIN')
    await enrolTotp(user.id, SECRET)

    const error = await caught(async () => removeFactor(await sessionEvent(user, { params: { id: 'totp' } })))
    expect(error?.statusCode).toBe(400)
    expect(await enrolledFactors(user.id)).toEqual(['totp'])
  })

  it('lets an ordinary account opt back out', async () => {
    const user = await createUser({ email: 'optout@example.com', plainPassword: 'Passw0rd' })
    await enrolTotp(user.id, SECRET)

    await removeFactor(await sessionEvent(user, { params: { id: 'totp' } }))
    expect(await enrolledFactors(user.id)).toEqual([])
  })
})

describe('admin reset', () => {
  it('clears every factor and audits it', async () => {
    const admin = await createUser({ email: 'reset-admin@example.com', plainPassword: 'Passw0rd', verified: true })
    await grantRole(admin.id, 'auth:ADMIN')
    await enrolTotp(admin.id, SECRET)

    const subject = await createUser({ email: 'lost-phone@example.com', plainPassword: 'Passw0rd' })
    await enrolTotp(subject.id, SECRET)
    await regenerateRecoveryCodes(subject.id)

    const event = await sessionEvent(admin, { params: { id: subject.id } })
    ;(await (globalThis as never as { getUserSession: (e: unknown) => Promise<{ user: { roles: string[] } }> })
      .getUserSession(event)).user.roles.push('auth:ADMIN')

    await mfaReset(event)

    expect(await enrolledFactors(subject.id)).toEqual([])
    expect(await remainingRecoveryCodes(subject.id)).toBe(0)

    // The sessions those factors gated must die with them.
    const row = await db.select().from(schema.users).where(eq(schema.users.id, subject.id)).get()
    expect(row!.sessionEpoch).toBe(1)

    const audit = await db.select().from(schema.auditLog)
      .where(eq(schema.auditLog.action, 'mfa.admin-reset')).all()
    expect(audit).toHaveLength(1)
    expect(audit[0]?.target).toBe(subject.id)
  })

  it('clearAllFactors leaves no trace of the account\'s MFA state', async () => {
    const user = await createUser({ email: 'wipe@example.com' })
    await enrolTotp(user.id, SECRET)
    await regenerateRecoveryCodes(user.id)
    await createMfaAttempt(user.id)

    await clearAllFactors(user.id)

    for (const table of [schema.totpSecrets, schema.mfaRecoveryCodes, schema.mfaChallenges, schema.webauthnCredentials]) {
      expect(await db.select().from(table).all()).toHaveLength(0)
    }
  })
})

describe('removing a factor counts credentials, not kinds', () => {
  it('lets an admin with two passkeys remove one', async () => {
    const user = await createUser({ email: 'two-keys@example.com', plainPassword: 'Passw0rd', verified: true })
    await grantRole(user.id, 'auth:ADMIN')
    const [first] = await db.insert(schema.webauthnCredentials).values({
      userId: user.id, credentialId: 'cred-a', publicKey: 'pk-a', counter: 0, backedUp: false, name: 'Laptop',
    }).returning()
    await db.insert(schema.webauthnCredentials).values({
      userId: user.id, credentialId: 'cred-b', publicKey: 'pk-b', counter: 0, backedUp: false, name: 'Phone',
    })

    const event = await sessionEvent(user, { params: { id: first!.id } })
    await expect(removeFactor(event)).resolves.toMatchObject({ ok: true })

    const left = await db.select().from(schema.webauthnCredentials)
      .where(eq(schema.webauthnCredentials.userId, user.id)).all()
    expect(left.map(c => c.credentialId)).toEqual(['cred-b'])
  })

  it('still refuses when it really is the only one left', async () => {
    const user = await createUser({ email: 'one-key@example.com', plainPassword: 'Passw0rd', verified: true })
    await grantRole(user.id, 'auth:ADMIN')
    const [only] = await db.insert(schema.webauthnCredentials).values({
      userId: user.id, credentialId: 'cred-only', publicKey: 'pk', counter: 0, backedUp: false, name: 'Laptop',
    }).returning()

    const event = await sessionEvent(user, { params: { id: only!.id } })
    await expect(removeFactor(event)).rejects.toMatchObject({ statusCode: 400 })
  })

  it('lets TOTP go while a passkey remains', async () => {
    const user = await createUser({ email: 'both@example.com', plainPassword: 'Passw0rd', verified: true })
    await grantRole(user.id, 'auth:ADMIN')
    await enrolTotp(user.id, SECRET)
    await db.insert(schema.webauthnCredentials).values({
      userId: user.id, credentialId: 'cred-c', publicKey: 'pk-c', counter: 0, backedUp: false, name: 'Phone',
    })

    const event = await sessionEvent(user, { params: { id: 'totp' } })
    await expect(removeFactor(event)).resolves.toMatchObject({ ok: true })
  })
})

describe('single-use secrets are claimed by the write, not the read', () => {
  it('spends a recovery code once even when two requests race', async () => {
    const user = await createUser({ email: 'race@example.com', plainPassword: 'Passw0rd' })
    const codes = await regenerateRecoveryCodes(user.id)
    const code = codes[0]!

    // Both see used_at IS NULL before either writes.
    const [a, b] = await Promise.all([
      useRecoveryCode(user.id, code),
      useRecoveryCode(user.id, code),
    ])

    expect([a, b].filter(Boolean)).toHaveLength(1)
    expect(await remainingRecoveryCodes(user.id)).toBe(codes.length - 1)
  })

  it('lets a pending login attempt be consumed only once', async () => {
    const user = await createUser({ email: 'attempt@example.com', plainPassword: 'Passw0rd' })
    const attemptId = await createMfaAttempt(user.id)

    const [first, second] = await Promise.all([
      consumeMfaAttempt(attemptId),
      consumeMfaAttempt(attemptId),
    ])

    expect([first, second].filter(Boolean)).toHaveLength(1)
  })
})

describe('self-service credential changes are audited', () => {
  it('records a password change against the account', async () => {
    const user = await createUser({ email: 'selfpw@example.com', plainPassword: 'Passw0rd', verified: true })
    const event = await sessionEvent(user, { body: { currentPassword: 'Passw0rd', password: 'N3wPassw0rd' } })

    await changeOwnPassword(event)

    const audit = await db.select().from(schema.auditLog)
      .where(eq(schema.auditLog.action, 'user.password-changed')).all()
    expect(audit).toHaveLength(1)
    expect(audit[0]?.target).toBe(user.id)
    expect(audit[0]?.actorUserId).toBe(user.id)
  })

  it('records that the email changed, and neither address', async () => {
    const user = await createUser({ email: 'old-self@example-user.co.uk', plainPassword: 'Passw0rd', verified: true })
    const event = await sessionEvent(user, { body: { email: 'new-self@example-user.co.uk' } })

    await changeOwnProfile(event)

    const audit = await db.select().from(schema.auditLog)
      .where(eq(schema.auditLog.action, 'user.updated')).all()
    expect(audit).toHaveLength(1)
    expect(audit[0]?.target).toBe(user.id)
    expect(audit[0]?.detail).toContain('emailChanged')
    // The id in `target` says who; an address here would outlive an erasure.
    expect(audit[0]?.detail).not.toContain('old-self@example-user.co.uk')
    expect(audit[0]?.detail).not.toContain('new-self@example-user.co.uk')
  })
})
