import { describe, expect, it } from 'bun:test'
import { db, schema } from '@nuxthub/db'
import { eq } from 'drizzle-orm'
import requestHandler from '../server/api/auth/magic-link/request.post'
import verifyHandler from '../server/api/auth/magic-link/verify.post'
import resetHandler from '../server/api/auth/password/reset.post'
import mfaVerifyHandler from '../server/api/auth/mfa/verify.post'
import { createMagicLinkToken, createPasswordResetToken, hashLoginToken } from '../server/utils/tokens'
import { consumeMfaAttempt, regenerateRecoveryCodes, useRecoveryCode } from '../server/utils/mfa'
import { makeEvent, sealedSession, sentEmails } from './setup'
import { createUser, grantRole, enrolTotp } from './helpers/users'

const request = requestHandler as unknown as (event: unknown) => Promise<Record<string, unknown>>
const verify = verifyHandler as unknown as (event: unknown) => Promise<Record<string, unknown>>
const reset = resetHandler as unknown as (event: unknown) => Promise<Record<string, unknown>>
const mfaVerify = mfaVerifyHandler as unknown as (event: unknown) => Promise<Record<string, unknown>>

const SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'

async function caught(fn: () => Promise<unknown>) {
  try {
    await fn()
    return undefined
  }
  catch (error) {
    return error as { statusCode: number, statusMessage: string, data?: Record<string, unknown> }
  }
}

describe('POST /api/auth/magic-link/request', () => {
  it('emails a link for an existing account and answers ok', async () => {
    const user = await createUser({ email: 'booker@example-user.co.uk' })

    const result = await request(makeEvent({ body: { email: 'booker@example-user.co.uk' } }))

    expect(result).toEqual({ ok: true })
    expect(sentEmails).toEqual([{ kind: 'magic-link', to: 'booker@example-user.co.uk', token: expect.any(String) }])

    // Stored hashed: never the plaintext that was emailed.
    const row = await db.select().from(schema.magicLinks)
      .where(eq(schema.magicLinks.userId, user.id)).get()
    expect(row?.tokenHash).toBe(hashLoginToken(sentEmails[0]!.token!))
    expect(row?.tokenHash).not.toBe(sentEmails[0]!.token)
  })

  it('answers the identical ok for unknown, undeliverable, and disabled accounts: sending nothing', async () => {
    await createUser({ email: 'disabled@example-user.co.uk', disabled: true })

    for (const email of ['nobody@example-user.co.uk', 'ghost@anonymised.invalid', 'disabled@example-user.co.uk']) {
      expect(await request(makeEvent({ body: { email } }))).toEqual({ ok: true })
    }
    expect(sentEmails).toHaveLength(0)
  })

  it('refuses Workspace addresses with the Google pointer (ADR-0012 exception)', async () => {
    const error = await caught(() => request(makeEvent({ body: { email: 'president@newtheatre.org.uk' } })))

    expect(error?.statusCode).toBe(403)
    expect(error?.data).toMatchObject({ useGoogle: true })
    expect(sentEmails).toHaveLength(0)
  })

  it('replaces an outstanding link rather than accumulating them', async () => {
    const user = await createUser({ email: 'again@example-user.co.uk' })

    await request(makeEvent({ body: { email: 'again@example-user.co.uk' } }))
    await request(makeEvent({ body: { email: 'again@example-user.co.uk' } }))

    const rows = await db.select().from(schema.magicLinks)
      .where(eq(schema.magicLinks.userId, user.id)).all()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.tokenHash).toBe(hashLoginToken(sentEmails[1]!.token!))
  })
})

describe('POST /api/auth/magic-link/verify', () => {
  it('seals a session, marks the address verified, and consumes the link', async () => {
    const user = await createUser({ email: 'clicker@example-user.co.uk', plainPassword: 'Passw0rd', verified: false })
    const token = await createMagicLinkToken(user.id)

    const event = makeEvent({ body: { token } })
    const result = await verify(event)

    expect((result.user as { id: string, verified: boolean })).toMatchObject({ id: user.id, verified: true })
    expect(sealedSession(event)).toBeDefined()

    const updated = await db.select().from(schema.users).where(eq(schema.users.id, user.id)).get()
    expect(updated?.verified).toBe(true)
    expect(updated?.lastLogin).not.toBeNull()

    // Single-use: the same link again is refused.
    expect((await caught(() => verify(makeEvent({ body: { token } }))))?.statusCode).toBe(400)
  })

  it('signs in a shadow account, keeping guest: true', async () => {
    const shadow = await createUser({ email: 'guest@example-user.co.uk' }) // no password, no google
    const token = await createMagicLinkToken(shadow.id)

    const event = makeEvent({ body: { token } })
    const result = await verify(event)

    expect((result.user as { guest: boolean }).guest).toBe(true)
    expect(sealedSession(event)).toBeDefined()
  })

  it('refuses expired links and unknown tokens with the same error', async () => {
    const user = await createUser({ email: 'slow@example-user.co.uk' })
    const token = await createMagicLinkToken(user.id)
    await db.update(schema.magicLinks)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(schema.magicLinks.userId, user.id))

    const expired = await caught(() => verify(makeEvent({ body: { token } })))
    const unknown = await caught(() => verify(makeEvent({ body: { token: 'no-such-token' } })))

    expect(expired?.statusCode).toBe(400)
    expect(expired?.statusMessage).toBe(unknown?.statusMessage)

    // The expired row was consumed too.
    expect(await db.select().from(schema.magicLinks).all()).toHaveLength(0)
  })

  it('refuses a link whose account was disabled after it was sent', async () => {
    const user = await createUser({ email: 'gone@example-user.co.uk' })
    const token = await createMagicLinkToken(user.id)
    await db.update(schema.users).set({ disabled: true }).where(eq(schema.users.id, user.id))

    const event = makeEvent({ body: { token } })
    expect((await caught(() => verify(event)))?.statusCode).toBe(400)
    expect(sealedSession(event)).toBeUndefined()
  })

  it('challenges an MFA-enrolled account instead of sealing: the link is not the second factor', async () => {
    const user = await createUser({ email: 'enrolled@example-user.co.uk', plainPassword: 'Passw0rd' })
    await grantRole(user.id, 'auth:ADMIN')
    await enrolTotp(user.id, SECRET)
    const token = await createMagicLinkToken(user.id)

    const event = makeEvent({ body: { token } })
    const result = await verify(event)

    expect(result.mfaRequired).toBe(true)
    expect(result.methods).toEqual(['totp'])
    expect(sealedSession(event)).toBeUndefined()

    // The attempt it handed back is a real one.
    expect(await consumeMfaAttempt(result.attemptId as string)).not.toBeNull()
  })
})

describe('password reset routes through the MFA seam (the old bypass)', () => {
  it('returns a challenge, not a session, for an enrolled account', async () => {
    const user = await createUser({ email: 'admin@example-user.co.uk', plainPassword: 'OldPassw0rd' })
    await grantRole(user.id, 'auth:ADMIN')
    await enrolTotp(user.id, SECRET)
    const token = await createPasswordResetToken(user.id)

    const event = makeEvent({ body: { token, password: 'NewPassw0rd' } })
    const result = await reset(event)

    // Without sealOrChallenge in reset.post.ts this expectation fails: the
    // old code sealed a session on mailbox control alone.
    expect(result.mfaRequired).toBe(true)
    expect(sealedSession(event)).toBeUndefined()

    // The password itself DID change (that part is mailbox-trust, as before)…
    const updated = await db.select().from(schema.users).where(eq(schema.users.id, user.id)).get()
    expect(await (globalThis as never as { verifyPassword: (h: string, p: string) => Promise<boolean> })
      .verifyPassword(updated!.password!, 'NewPassw0rd')).toBe(true)

    // …and the factor still finishes the login.
    const [code] = await regenerateRecoveryCodes(user.id)
    const finish = makeEvent({ body: { attemptId: result.attemptId, code: code! } })
    await mfaVerify(finish)
    expect(sealedSession(finish)).toBeDefined()
  })

  it('still seals directly for an account with no factors', async () => {
    const user = await createUser({ email: 'plain@example-user.co.uk', plainPassword: 'OldPassw0rd' })
    const token = await createPasswordResetToken(user.id)

    const event = makeEvent({ body: { token, password: 'NewPassw0rd' } })
    const result = await reset(event)

    expect(result).toEqual({ ok: true })
    expect(sealedSession(event)).toBeDefined()
  })
})

describe('recovery codes forgive pasted whitespace', () => {
  it('accepts a code wrapped in spaces and newlines', async () => {
    const user = await createUser({ email: 'paste@example-user.co.uk' })
    const [code] = await regenerateRecoveryCodes(user.id)

    expect(await useRecoveryCode(user.id, `  ${code!.toUpperCase()} \n`)).toBe(true)
  })
})

describe('a magic link is claimed by the delete, not the read', () => {
  it('seals at most one session when two requests race the same link', async () => {
    const user = await createUser({ email: 'racer@example-user.co.uk', verified: true })
    const token = await createMagicLinkToken(user.id)

    const events = [makeEvent({ body: { token } }), makeEvent({ body: { token } })]
    const results = await Promise.allSettled(events.map(e => verify(e)))

    const fulfilled = results.filter(r => r.status === 'fulfilled')
    expect(fulfilled).toHaveLength(1)
    expect(events.filter(e => sealedSession(e)).length).toBe(1)
  })
})
