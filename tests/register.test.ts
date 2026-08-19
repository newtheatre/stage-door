import { describe, expect, it } from 'vitest'
import { db, schema } from '@nuxthub/db'
import { eq } from 'drizzle-orm'
import registerHandler from '../server/api/auth/register.post'
import { makeEvent, sealedSession, sentEmails } from './setup'
import { createUser } from './helpers/users'

const register = registerHandler as unknown as (event: unknown) => Promise<{ ok: boolean }>

describe('POST /api/auth/register', () => {
  it('creates a user and sends a verification email, without sealing a session', async () => {
    const event = makeEvent({ body: { email: 'New@Example-USER.co.UK', name: 'New Person', password: 'Passw0rd' } })
    const result = await register(event)

    expect(result).toEqual({ ok: true })

    const user = await db.select().from(schema.users).where(eq(schema.users.email, 'new@example-user.co.uk')).get()
    expect(user).toBeTruthy()
    expect(user!.email).toBe('new@example-user.co.uk') // lowercased on the way in
    expect(user!.password).toBe('fake$Passw0rd')
    expect(user!.verified).toBe(false)

    expect(sentEmails).toEqual([
      { kind: 'verification', to: 'new@example-user.co.uk', token: expect.any(String) },
    ])

    // ADR-0022: the mailbox is the proof, so registering never signs anyone in.
    expect(sealedSession(event)).toBeUndefined()
  })

  it('emails a set-password link for a shadow account instead of claiming it', async () => {
    const shadow = await createUser({ email: 'booker@example-user.co.uk', name: 'Old Booking Name' })

    const event = makeEvent({ body: { email: 'booker@example-user.co.uk', name: 'Real Name', password: 'Passw0rd' } })
    await register(event)

    const untouched = await db.select().from(schema.users).where(eq(schema.users.id, shadow.id)).get()
    expect(untouched!.password).toBeNull() // no credential written without the round-trip
    expect(untouched!.name).toBe('Old Booking Name')

    expect(sentEmails).toEqual([{ kind: 'reset', to: 'booker@example-user.co.uk', token: expect.any(String) }])
    expect(sealedSession(event)).toBeUndefined()
  })

  it('will not hand over an admin-created account that already holds roles', async () => {
    const invited = await createUser({ email: 'newcommittee@example-user.co.uk', name: 'Invited' })
    await db.insert(schema.userRoles).values({
      userId: invited.id,
      role: 'proscenium:ADMIN',
      expiresAt: null,
      note: null,
      grantedBy: null,
      grantedAt: new Date(),
    })

    const event = makeEvent({ body: { email: 'newcommittee@example-user.co.uk', name: 'Imposter', password: 'Attack3r' } })
    await register(event)

    const row = await db.select().from(schema.users).where(eq(schema.users.id, invited.id)).get()
    expect(row!.password).toBeNull()
    // The roles only ever reach whoever opens the emailed link.
    expect(sealedSession(event)).toBeUndefined()
  })

  it('will not claim a disabled account, and emails nothing', async () => {
    const banned = await createUser({ email: 'banned@example-user.co.uk', name: 'Banned' })
    await db.update(schema.users).set({ disabled: true }).where(eq(schema.users.id, banned.id))

    const event = makeEvent({ body: { email: 'banned@example-user.co.uk', name: 'Banned', password: 'Passw0rd' } })
    const result = await register(event)

    expect(result).toEqual({ ok: true })
    const row = await db.select().from(schema.users).where(eq(schema.users.id, banned.id)).get()
    expect(row!.password).toBeNull()
    expect(row!.disabled).toBe(true)
    expect(sealedSession(event)).toBeUndefined()
    expect(sentEmails).toHaveLength(0)
  })

  it('is enumeration-safe when the email already has a full account', async () => {
    const existing = await createUser({ email: 'taken@example-user.co.uk', name: 'Original', plainPassword: 'Original0' })

    const event = makeEvent({ body: { email: 'taken@example-user.co.uk', name: 'Imposter', password: 'Attack3r' } })
    const result = await register(event)

    expect(result).toEqual({ ok: true })
    const untouched = await db.select().from(schema.users).where(eq(schema.users.id, existing.id)).get()
    expect(untouched!.password).toBe('fake$Original0')
    expect(untouched!.name).toBe('Original')
    expect(sealedSession(event)).toBeUndefined()
    expect(sentEmails).toEqual([{ kind: 'account-exists', to: 'taken@example-user.co.uk' }])
  })

  it('seals no session on any path, so Set-Cookie cannot enumerate', async () => {
    await createUser({ email: 'full@example-user.co.uk', plainPassword: 'Original0' })
    await createUser({ email: 'shadow@example-user.co.uk' })

    for (const email of ['fresh@example-user.co.uk', 'full@example-user.co.uk', 'shadow@example-user.co.uk']) {
      const event = makeEvent({ body: { email, name: 'Someone', password: 'Passw0rd' } })
      expect(await register(event)).toEqual({ ok: true })
      expect(sealedSession(event)).toBeUndefined()
    }
  })

  it('treats an SSO-only account (no password, has google_sub) as full, not shadow', async () => {
    await createUser({ email: 'sso@example-user.co.uk', googleSub: 'google-sub-123' })

    const event = makeEvent({ body: { email: 'sso@example-user.co.uk', name: 'Imposter', password: 'Attack3r' } })
    const result = await register(event)

    expect(result).toEqual({ ok: true })
    expect(sealedSession(event)).toBeUndefined()
    expect(sentEmails).toEqual([{ kind: 'account-exists', to: 'sso@example-user.co.uk' }])
  })

  it('never claims accounts on undeliverable domains — the legacy-import hole', async () => {
    // Placeholder rows on reserved TLDs can own reservations containing other
    // customers' data, so registering with one must be a silent no-op.
    const placeholder = await createUser({ email: 'door-sales@legacy.invalid', name: 'Door Sales' })
    const anonymised = await createUser({ email: 'deleted-123@anonymised.invalid', name: 'Deleted user' })

    for (const email of ['door-sales@legacy.invalid', 'Deleted-123@ANONYMISED.INVALID', 'someone@example.com', 'x@foo.test']) {
      const event = makeEvent({ body: { email, name: 'Attacker', password: 'Attack3rPw' } })
      const result = await register(event)
      expect(result).toEqual({ ok: true })
      expect(sealedSession(event)).toBeUndefined()
    }

    // Nothing was claimed, created, or emailed.
    const [row1] = await db.select().from(schema.users).where(eq(schema.users.id, placeholder.id)).all()
    expect(row1!.password).toBeNull()
    const [row2] = await db.select().from(schema.users).where(eq(schema.users.id, anonymised.id)).all()
    expect(row2!.password).toBeNull()
    const all = await db.select().from(schema.users).all()
    expect(all).toHaveLength(2)
    expect(sentEmails).toHaveLength(0)
  })

  it('rate-limits per account, not only per IP', async () => {
    // makeEvent hands every event a distinct cf-connecting-ip, so the IP rule
    // never trips here — only the account rule can.
    const body = { email: 'victim@example-user.co.uk', name: 'V', password: 'Passw0rd' }
    for (let i = 0; i < 5; i++) {
      await register(makeEvent({ body }))
    }

    await expect(register(makeEvent({ body }))).rejects.toThrow()
  })

  it('rejects weak passwords', async () => {
    const event = makeEvent({ body: { email: 'weak@example-user.co.uk', name: 'Weak', password: 'password' } })
    await expect(register(event)).rejects.toThrow()
  })
})
