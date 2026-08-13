import { describe, expect, it } from 'vitest'
import { db, schema } from '@nuxthub/db'
import { hashLoginToken } from '../server/utils/tokens'
import { eq } from 'drizzle-orm'
import forgotHandler from '../server/api/auth/password/forgot.post'
import resetHandler from '../server/api/auth/password/reset.post'
import { makeEvent, sealedSession, sentEmails } from './setup'
import { createUser } from './helpers/users'

const forgot = forgotHandler as unknown as (event: unknown) => Promise<{ ok: boolean }>
const reset = resetHandler as unknown as (event: unknown) => Promise<{ ok: boolean }>

describe('POST /api/auth/password/forgot', () => {
  it('sends a reset email for an existing account', async () => {
    const user = await createUser({ email: 'alice@example-user.co.uk', plainPassword: 'Passw0rd' })

    const result = await forgot(makeEvent({ body: { email: 'alice@example-user.co.uk' } }))

    expect(result).toEqual({ ok: true })
    expect(sentEmails).toEqual([{ kind: 'reset', to: 'alice@example-user.co.uk', token: expect.any(String) }])

    const record = await db.select().from(schema.passwordResets)
      .where(eq(schema.passwordResets.userId, user.id)).get()
    // Hashed at rest: the stored value is the SHA-256 of what was emailed.
    expect(record?.token).toBe(hashLoginToken(sentEmails[0]!.token!))
    expect(record?.token).not.toBe(sentEmails[0]!.token)
  })

  it('sends a reset email for a shadow account — the claiming path', async () => {
    await createUser({ email: 'booker@example-user.co.uk' }) // password NULL

    await forgot(makeEvent({ body: { email: 'booker@example-user.co.uk' } }))

    expect(sentEmails).toHaveLength(1)
    expect(sentEmails[0]!.kind).toBe('reset')
  })

  it('returns the same response for unknown and disabled accounts, without sending', async () => {
    await createUser({ email: 'off@example-user.co.uk', plainPassword: 'Passw0rd', disabled: true })

    const unknown = await forgot(makeEvent({ body: { email: 'nobody@example-user.co.uk' } }))
    const disabled = await forgot(makeEvent({ body: { email: 'off@example-user.co.uk' } }))

    expect(unknown).toEqual({ ok: true })
    expect(disabled).toEqual({ ok: true })
    expect(sentEmails).toHaveLength(0)
  })

  it('replaces outstanding reset tokens rather than accumulating them', async () => {
    const user = await createUser({ email: 'alice@example-user.co.uk', plainPassword: 'Passw0rd' })

    await forgot(makeEvent({ body: { email: 'alice@example-user.co.uk' } }))
    await forgot(makeEvent({ body: { email: 'alice@example-user.co.uk' } }))

    const records = await db.select().from(schema.passwordResets)
      .where(eq(schema.passwordResets.userId, user.id)).all()
    expect(records).toHaveLength(1)
    expect(records[0]!.token).toBe(hashLoginToken(sentEmails[1]!.token!))
  })
})

describe('POST /api/auth/password/reset', () => {
  async function issueToken(userId: string, expiresInMs = 60 * 60_000): Promise<string> {
    const token = `token-${userId}-${Math.random().toString(36).slice(2)}`
    await db.insert(schema.passwordResets).values({
      userId,
      token: hashLoginToken(token), // hashed at rest (ADR-0013)
      expiresAt: new Date(Date.now() + expiresInMs),
    })
    return token
  }

  it('sets the password, bumps the session epoch, consumes tokens, and logs in', async () => {
    const user = await createUser({ email: 'alice@example-user.co.uk', plainPassword: 'OldPassw0rd' })
    const token = await issueToken(user.id)

    const event = makeEvent({ body: { token, password: 'NewPassw0rd' } })
    const result = await reset(event)

    expect(result).toEqual({ ok: true })

    const updated = await db.select().from(schema.users).where(eq(schema.users.id, user.id)).get()
    expect(updated!.password).toBe('fake$NewPassw0rd')
    expect(updated!.sessionEpoch).toBe(1) // old sessions everywhere invalidated at refresh

    const remaining = await db.select().from(schema.passwordResets)
      .where(eq(schema.passwordResets.userId, user.id)).all()
    expect(remaining).toHaveLength(0)

    const session = sealedSession(event)!
    expect(session.epoch).toBe(1) // sealed with the *new* epoch
    expect(session.user).toMatchObject({ id: user.id })
  })

  it('claims a shadow account: guest flips to false in the fresh session', async () => {
    const shadow = await createUser({ email: 'booker@example-user.co.uk' })
    const token = await issueToken(shadow.id)

    const event = makeEvent({ body: { token, password: 'NewPassw0rd' } })
    await reset(event)

    expect(sealedSession(event)?.user).toMatchObject({ id: shadow.id, guest: false })
  })

  it('rejects an expired token and deletes it', async () => {
    const user = await createUser({ email: 'alice@example-user.co.uk', plainPassword: 'OldPassw0rd' })
    const token = await issueToken(user.id, -1000)

    await expect(reset(makeEvent({ body: { token, password: 'NewPassw0rd' } })))
      .rejects.toMatchObject({ statusCode: 400 })

    const remaining = await db.select().from(schema.passwordResets)
      .where(eq(schema.passwordResets.userId, user.id)).all()
    expect(remaining).toHaveLength(0)

    const untouched = await db.select().from(schema.users).where(eq(schema.users.id, user.id)).get()
    expect(untouched!.password).toBe('fake$OldPassw0rd')
  })

  it('rejects an unknown token', async () => {
    await expect(reset(makeEvent({ body: { token: 'no-such-token', password: 'NewPassw0rd' } })))
      .rejects.toMatchObject({ statusCode: 400 })
  })

  it('never seals a session for a disabled account', async () => {
    const user = await createUser({ email: 'off@example-user.co.uk', plainPassword: 'OldPassw0rd', disabled: true })
    const token = await issueToken(user.id)

    const event = makeEvent({ body: { token, password: 'NewPassw0rd' } })
    await expect(reset(event)).rejects.toMatchObject({ statusCode: 400 })
    expect(sealedSession(event)).toBeUndefined()
  })
})
