import { describe, expect, it } from 'bun:test'
import { db, schema } from '@nuxthub/db'
import { hashLoginToken } from '../server/utils/tokens'
import { eq } from 'drizzle-orm'
import verifyHandler from '../server/api/auth/email/verify.post'
import { makeEvent, sealedSession, sentEmails } from './setup'
import { createUser } from './helpers/users'

const verify = verifyHandler as unknown as (event: unknown) => Promise<{ ok: boolean }>

async function issueToken(userId: string, expiresInMs = 24 * 60 * 60_000): Promise<string> {
  const token = `verify-${userId}-${Math.random().toString(36).slice(2)}`
  await db.insert(schema.emailVerifications).values({
    userId,
    token: hashLoginToken(token), // hashed at rest (ADR-0013)
    expiresAt: new Date(Date.now() + expiresInMs),
  })
  return token
}

describe('POST /api/auth/email/verify', () => {
  it('verifies the address and consumes the token', async () => {
    const user = await createUser({ email: 'alice@example.com', plainPassword: 'Passw0rd' })
    const token = await issueToken(user.id)

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
    const token = await issueToken(user.id)

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
    const token = await issueToken(user.id)

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
    const token = await issueToken(user.id)
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

  it('auto-resends on an expired token and reports 400', async () => {
    const user = await createUser({ email: 'alice@example.com', plainPassword: 'Passw0rd' })
    const token = await issueToken(user.id, -1000)

    await expect(verify(makeEvent({ body: { token } })))
      .rejects.toMatchObject({ statusCode: 400 })

    // Expired token consumed, replacement issued and emailed.
    expect(sentEmails).toEqual([{ kind: 'verification', to: 'alice@example.com', token: expect.any(String) }])
    const records = await db.select().from(schema.emailVerifications)
      .where(eq(schema.emailVerifications.userId, user.id)).all()
    expect(records).toHaveLength(1)
    expect(records[0]!.token).not.toBe(hashLoginToken(token))
  })

  it('rejects an unknown token', async () => {
    await expect(verify(makeEvent({ body: { token: 'no-such-token' } })))
      .rejects.toMatchObject({ statusCode: 400 })
  })
})
