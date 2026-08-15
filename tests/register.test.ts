import { describe, expect, it } from 'vitest'
import { db, schema } from '@nuxthub/db'
import { eq } from 'drizzle-orm'
import registerHandler from '../server/api/auth/register.post'
import { makeEvent, sealedSession, sentEmails } from './setup'
import { createUser } from './helpers/users'

const register = registerHandler as unknown as (event: unknown) => Promise<{ ok: boolean }>

describe('POST /api/auth/register', () => {
  it('creates a user, sends a verification email, and seals a session', async () => {
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

    const session = sealedSession(event)!
    expect(session.user).toMatchObject({ id: user!.id, guest: false, roles: [] })
  })

  it('claims a shadow account in place, keeping its id', async () => {
    const shadow = await createUser({ email: 'booker@example-user.co.uk', name: 'Old Booking Name' })

    const event = makeEvent({ body: { email: 'booker@example-user.co.uk', name: 'Real Name', password: 'Passw0rd' } })
    await register(event)

    const claimed = await db.select().from(schema.users).where(eq(schema.users.email, 'booker@example-user.co.uk')).get()
    expect(claimed!.id).toBe(shadow.id) // history stays attached
    expect(claimed!.password).toBe('fake$Passw0rd')
    expect(claimed!.name).toBe('Real Name')

    expect(sealedSession(event)?.user).toMatchObject({ id: shadow.id, guest: false })
  })

  it('is enumeration-safe when the email already has a full account', async () => {
    const existing = await createUser({ email: 'taken@example-user.co.uk', name: 'Original', plainPassword: 'Original0' })

    const event = makeEvent({ body: { email: 'taken@example-user.co.uk', name: 'Imposter', password: 'Attack3r' } })
    const result = await register(event)

    // Same response shape as success…
    expect(result).toEqual({ ok: true })
    // …but nothing was changed, no session sealed, and the only email is the
    // "you already have an account" notice.
    const untouched = await db.select().from(schema.users).where(eq(schema.users.id, existing.id)).get()
    expect(untouched!.password).toBe('fake$Original0')
    expect(untouched!.name).toBe('Original')
    expect(sealedSession(event)).toBeUndefined()
    expect(sentEmails).toEqual([{ kind: 'account-exists', to: 'taken@example-user.co.uk' }])
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

  it('rejects weak passwords', async () => {
    const event = makeEvent({ body: { email: 'weak@example-user.co.uk', name: 'Weak', password: 'password' } })
    await expect(register(event)).rejects.toThrow()
  })
})
