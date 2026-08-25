import { describe, expect, it } from 'bun:test'
import { db, schema } from '@nuxthub/db'
import { createEmailVerificationToken, hashLoginToken } from '../server/utils/tokens'
import { eq } from 'drizzle-orm'
import verifyHandler from '../server/api/auth/email/verify.post'
import { RATE_LIMITS } from '../server/utils/rateLimit'
import { makeEvent, sealedSession, sentEmails } from './setup'
import { createUser } from './helpers/users'

const verify = verifyHandler as unknown as (event: unknown) => Promise<{ ok: boolean }>

async function issueToken(userId: string, email: string, expiresInMs = 24 * 60 * 60_000): Promise<string> {
  const token = `verify-${userId}-${Math.random().toString(36).slice(2)}`
  await db.insert(schema.emailVerifications).values({
    userId,
    email,
    token: hashLoginToken(token), // hashed at rest (ADR-0013)
    expiresAt: new Date(Date.now() + expiresInMs),
  })
  return token
}

describe('POST /api/auth/email/verify', () => {
  it('verifies the address and consumes the token', async () => {
    const user = await createUser({ email: 'alice@example.com', plainPassword: 'Passw0rd' })
    const token = await issueToken(user.id, user.email)

    const result = await verify(makeEvent({ body: { token } }))
    expect(result).toEqual({ ok: true })

    const updated = await db.select().from(schema.users).where(eq(schema.users.id, user.id)).get()
    expect(updated!.verified).toBe(true)

    const remaining = await db.select().from(schema.emailVerifications)
      .where(eq(schema.emailVerifications.userId, user.id)).all()
    expect(remaining).toHaveLength(0)
  })

  it('re-seals the caller\'s session with verified: true', async () => {
    const user = await createUser({ email: 'alice@example.com', plainPassword: 'Passw0rd' })
    const token = await issueToken(user.id, user.email)

    const event = makeEvent({ body: { token } })
    // Simulate the user being logged in when they click the link.
    await (globalThis as never as { setUserSession: (e: unknown, s: unknown) => Promise<unknown> })
      .setUserSession(event, {
        user: { id: user.id, email: user.email, name: user.name, verified: false, guest: false, roles: [] },
        loggedInAt: Date.now() - 5_000,
        refreshedAt: Date.now() - 5_000,
        epoch: 0,
      })

    await verify(event)

    const session = sealedSession(event)!
    expect(session.user).toMatchObject({ id: user.id, verified: true })
    expect(session.loggedInAt).toBeLessThan(Date.now()) // original login time preserved
  })

  it('does not re-seal a session that force-logout revoked', async () => {
    const user = await createUser({ email: 'alice@example.com', plainPassword: 'Passw0rd' })
    const token = await issueToken(user.id, user.email)

    // Admin bumps the epoch after the cookie was sealed.
    await db.update(schema.users).set({ sessionEpoch: 1 }).where(eq(schema.users.id, user.id))

    const event = makeEvent({ body: { token } })
    await (globalThis as never as { setUserSession: (e: unknown, s: unknown) => Promise<unknown> })
      .setUserSession(event, {
        user: { id: user.id, email: user.email, name: user.name, verified: false, guest: false, roles: [] },
        loggedInAt: Date.now() - 5_000,
        refreshedAt: Date.now() - 5_000,
        epoch: 0,
      })

    await verify(event)

    // The address is verified, but the revoked cookie is left untouched:
    // still the stale epoch, still verified: false.
    const row = await db.select().from(schema.users).where(eq(schema.users.id, user.id)).get()
    expect(row!.verified).toBe(true)
    const session = sealedSession(event)!
    expect(session.epoch).toBe(0)
    expect(session.user).toMatchObject({ verified: false })
  })

  it('does not re-seal a session for a disabled account', async () => {
    const user = await createUser({ email: 'bob@example.com', plainPassword: 'Passw0rd' })
    const token = await issueToken(user.id, user.email)
    await db.update(schema.users).set({ disabled: true }).where(eq(schema.users.id, user.id))

    const event = makeEvent({ body: { token } })
    await (globalThis as never as { setUserSession: (e: unknown, s: unknown) => Promise<unknown> })
      .setUserSession(event, {
        user: { id: user.id, email: user.email, name: user.name, verified: false, guest: false, roles: [] },
        loggedInAt: Date.now() - 5_000,
        refreshedAt: Date.now() - 5_000,
        epoch: 0,
      })

    await verify(event)
    expect(sealedSession(event)!.user).toMatchObject({ verified: false })
  })

  it('consumes an expired token, reports 400, and sends nothing', async () => {
    const user = await createUser({ email: 'alice@example.com', plainPassword: 'Passw0rd' })
    const token = await issueToken(user.id, user.email, -1000)

    await expect(verify(makeEvent({ body: { token } })))
      .rejects.toMatchObject({ statusCode: 400 })

    // An unauthenticated caller must not be able to spend the mail budget.
    expect(sentEmails).toHaveLength(0)
    const records = await db.select().from(schema.emailVerifications)
      .where(eq(schema.emailVerifications.userId, user.id)).all()
    expect(records).toHaveLength(0)
  })

  it('lets only one of two requests carrying the same token redeem it', async () => {
    const user = await createUser({ email: 'race@example.com', plainPassword: 'Passw0rd' })
    const token = await issueToken(user.id, user.email)

    const results = await Promise.allSettled([
      verify(makeEvent({ body: { token } })),
      verify(makeEvent({ body: { token } })),
    ])

    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter(r => r.status === 'rejected')).toHaveLength(1)
  })

  it('counts attempts per IP, so a sweep is visible and bounded', async () => {
    const ip = '10.9.9.9'
    for (let i = 0; i < RATE_LIMITS['verify:ip'].limit; i++) {
      await expect(verify(makeEvent({ body: { token: 'no-such-token' }, headers: { 'cf-connecting-ip': ip } })))
        .rejects.toMatchObject({ statusCode: 400 })
    }

    await expect(verify(makeEvent({ body: { token: 'no-such-token' }, headers: { 'cf-connecting-ip': ip } })))
      .rejects.toMatchObject({ statusCode: 429 })
  })

  it('rejects an unknown token', async () => {
    await expect(verify(makeEvent({ body: { token: 'no-such-token' } })))
      .rejects.toMatchObject({ statusCode: 400 })
  })

  it('refuses a token minted for an address the account no longer holds', async () => {
    const user = await createUser({ email: 'attacker@gmail.com', plainPassword: 'Passw0rd' })
    const stale = await issueToken(user.id, 'attacker@gmail.com')

    // The account is re-pointed at someone else's address, as profile.put does.
    await db.update(schema.users)
      .set({ email: 'victim@gmail.com', verified: false })
      .where(eq(schema.users.id, user.id))

    await expect(verify(makeEvent({ body: { token: stale } })))
      .rejects.toMatchObject({ statusCode: 400 })

    const row = await db.select().from(schema.users).where(eq(schema.users.id, user.id)).get()
    expect(row!.verified).toBe(false)
  })

  it('refuses a token carrying no address at all', async () => {
    const user = await createUser({ email: 'alice@example.com', plainPassword: 'Passw0rd' })
    const token = `verify-legacy-${user.id}`
    await db.insert(schema.emailVerifications).values({
      userId: user.id,
      token: hashLoginToken(token),
      expiresAt: new Date(Date.now() + 60_000),
    })

    await expect(verify(makeEvent({ body: { token } })))
      .rejects.toMatchObject({ statusCode: 400 })

    const row = await db.select().from(schema.users).where(eq(schema.users.id, user.id)).get()
    expect(row!.verified).toBe(false)
  })

  it('drops outstanding tokens when a fresh one is issued', async () => {
    const user = await createUser({ email: 'alice@example.com', plainPassword: 'Passw0rd' })
    const first = await issueToken(user.id, user.email)
    await createEmailVerificationToken(user.id, user.email)

    await expect(verify(makeEvent({ body: { token: first } })))
      .rejects.toMatchObject({ statusCode: 400 })

    const rows = await db.select().from(schema.emailVerifications)
      .where(eq(schema.emailVerifications.userId, user.id)).all()
    expect(rows).toHaveLength(1)
  })
})
