import { describe, expect, it } from 'vitest'
import { db, schema } from '@nuxthub/db'
import { eq } from 'drizzle-orm'
import { isWorkspaceEmail } from '../server/utils/validation'
import loginHandler from '../server/api/auth/login.post'
import forgotHandler from '../server/api/auth/password/forgot.post'
import registerHandler from '../server/api/auth/register.post'
import { makeEvent, sealedSession, sentEmails } from './setup'
import { resolveGoogleUser } from '../server/utils/googleAccount'
import { createUser } from './helpers/users'

const login = loginHandler as unknown as (event: unknown) => Promise<unknown>
const forgot = forgotHandler as unknown as (event: unknown) => Promise<{ ok: boolean }>
const register = registerHandler as unknown as (event: unknown) => Promise<{ ok: boolean }>

describe('isWorkspaceEmail', () => {
  it.each([
    'president@newtheatre.org.uk',
    'Matt.Adcock@NEWTHEATRE.ORG.UK',
  ])('%s is a Workspace address', (email) => {
    expect(isWorkspaceEmail(email)).toBe(true)
  })

  it.each([
    // Subdomains are not Workspace accounts — this is what keeps the dev
    // seed (@dev.newtheatre.org.uk) able to log in with a password locally.
    'admin@dev.newtheatre.org.uk',
    'matthew.n.adcock@gmail.com',
    'new-theatre@uonsu.com',
    // Lookalikes must not slip through.
    'someone@evil-newtheatre.org.uk',
    'someone@newtheatre.org.uk.evil.com',
  ])('%s is not', (email) => {
    expect(isWorkspaceEmail(email)).toBe(false)
  })
})

describe('Workspace addresses cannot use password login (ADR-0012)', () => {
  it('refuses password login with a 403 that points at Google — deliberately not the generic 401', async () => {
    // The account exists with a valid password; the domain rule still wins.
    await createUser({ email: 'president@newtheatre.org.uk', plainPassword: 'Passw0rd', verified: true })

    const event = makeEvent({ body: { email: 'president@newtheatre.org.uk', password: 'Passw0rd' } })
    await expect(login(event)).rejects.toMatchObject({ statusCode: 403 })
    expect(sealedSession(event)).toBeUndefined()
  })

  it('refuses even with the wrong password, and never reveals which', async () => {
    await createUser({ email: 'president@newtheatre.org.uk', plainPassword: 'Passw0rd' })

    const wrong = makeEvent({ body: { email: 'president@newtheatre.org.uk', password: 'WrongPassw0rd' } })
    const unknown = makeEvent({ body: { email: 'nobody@newtheatre.org.uk', password: 'WrongPassw0rd' } })

    for (const event of [wrong, unknown]) {
      await expect(login(event)).rejects.toMatchObject({ statusCode: 403 })
    }
  })

  it('still lets non-Workspace accounts log in normally', async () => {
    await createUser({ email: 'matt@example-user.co.uk', plainPassword: 'Passw0rd', verified: true })

    const event = makeEvent({ body: { email: 'matt@example-user.co.uk', password: 'Passw0rd' } })
    await login(event)
    expect(sealedSession(event)?.user).toMatchObject({ email: 'matt@example-user.co.uk' })
  })

  it('will not send a reset link that would restore password login', async () => {
    await createUser({ email: 'president@newtheatre.org.uk', plainPassword: 'Passw0rd' })

    const result = await forgot(makeEvent({ body: { email: 'president@newtheatre.org.uk' } }))

    expect(result).toEqual({ ok: true }) // enumeration-safe: same body as always
    expect(sentEmails).toHaveLength(0)
    const tokens = await db.select().from(schema.passwordResets).all()
    expect(tokens).toHaveLength(0)
  })

  it('will not register a Workspace address with a password', async () => {
    const event = makeEvent({ body: { email: 'newbie@newtheatre.org.uk', name: 'New Person', password: 'Passw0rd' } })

    const result = await register(event)

    expect(result).toEqual({ ok: true })
    expect(sealedSession(event)).toBeUndefined()
    expect(await db.select().from(schema.users).all()).toHaveLength(0)
    expect(sentEmails).toHaveLength(0)
  })

  it('leaves the Google path untouched — a Workspace account still signs in and keeps its history', async () => {
    // resolveGoogleUser is what picks these accounts up on next sign-in.
    const existing = await createUser({ email: 'president@newtheatre.org.uk', plainPassword: 'Passw0rd' })

    const { user, how } = await resolveGoogleUser({
      sub: 'google-sub-president',
      email: 'president@newtheatre.org.uk',
      email_verified: true,
      hd: 'newtheatre.org.uk',
      name: 'President',
    })

    expect(how).toBe('email')
    expect(user.id).toBe(existing.id) // same account, same roles, same history
    const linked = await db.select().from(schema.users).where(eq(schema.users.id, existing.id)).get()
    expect(linked!.googleSub).toBe('google-sub-president')
  })
})
