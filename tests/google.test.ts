import { describe, expect, it } from 'bun:test'
import { db, schema } from '@nuxthub/db'
import { eq } from 'drizzle-orm'
import { isWorkspaceProfile, resolveGoogleUser } from '../server/utils/googleAccount'
import type { GoogleProfile } from '../server/utils/googleAccount'
import { createUser } from './helpers/users'

function profile(overrides: Partial<GoogleProfile> = {}): GoogleProfile {
  return {
    sub: 'google-sub-1',
    email: 'Person@newtheatre.org.uk',
    email_verified: true,
    hd: 'newtheatre.org.uk',
    name: 'Person Name',
    ...overrides,
  }
}

describe('isWorkspaceProfile: CLAUDE.md invariant 5', () => {
  it('accepts a verified Workspace profile', () => {
    expect(isWorkspaceProfile(profile())).toBe(true)
  })

  it('rejects a missing hd claim (personal Google account)', () => {
    expect(isWorkspaceProfile(profile({ hd: undefined }))).toBe(false)
  })

  it('rejects a wrong hd claim (another Workspace)', () => {
    expect(isWorkspaceProfile(profile({ hd: 'evil.example.com' }))).toBe(false)
  })

  it('rejects unverified email even with the right hd', () => {
    expect(isWorkspaceProfile(profile({ email_verified: false }))).toBe(false)
  })
})

describe('resolveGoogleUser: a disabled account is never written to', () => {
  it('does not consume an admin-directed pending link', async () => {
    const user = await createUser({ email: 'president@newtheatre.org.uk', name: 'President' })
    await db.update(schema.users)
      .set({ disabled: true, pendingGoogleEmail: 'president@newtheatre.org.uk' })
      .where(eq(schema.users.id, user.id))

    const { user: resolved } = await resolveGoogleUser(profile({ email: 'president@newtheatre.org.uk' }))
    expect(resolved.disabled).toBe(true)

    const row = await db.select().from(schema.users).where(eq(schema.users.id, user.id)).get()
    expect(row!.googleSub).toBeNull() // no permanent linkage on a rejected sign-in
    expect(row!.pendingGoogleEmail).toBe('president@newtheatre.org.uk') // intent survives
  })

  it('does not link by email or flip verified', async () => {
    const user = await createUser({ email: 'banned@newtheatre.org.uk', name: 'Banned' })
    await db.update(schema.users).set({ disabled: true, verified: false }).where(eq(schema.users.id, user.id))

    await resolveGoogleUser(profile({ email: 'banned@newtheatre.org.uk' }))

    const row = await db.select().from(schema.users).where(eq(schema.users.id, user.id)).get()
    expect(row!.googleSub).toBeNull()
    expect(row!.verified).toBe(false)
  })
})

describe('resolveGoogleUser: match precedence', () => {
  it('creates a new verified, password-less user when nothing matches', async () => {
    const { user, how } = await resolveGoogleUser(profile())

    expect(how).toBe('created')
    expect(user.email).toBe('person@newtheatre.org.uk') // lowercased
    expect(user.verified).toBe(true)
    expect(user.password).toBeNull()
    expect(user.googleSub).toBe('google-sub-1')
  })

  it('google_sub match wins even when the address has changed', async () => {
    const existing = await createUser({
      email: 'old-address@example.com',
      plainPassword: 'Passw0rd',
      googleSub: 'google-sub-1',
    })

    // Same sub, different (re-pointed) email: must still resolve to the row.
    const { user, how } = await resolveGoogleUser(profile({ email: 'renamed@newtheatre.org.uk' }))

    expect(how).toBe('sub')
    expect(user.id).toBe(existing.id)
    expect(user.email).toBe('old-address@example.com') // email never rewritten
  })

  it('consumes pending_google_email and links, keeping the account email', async () => {
    const account = await createUser({
      email: 'personal@example.com',
      plainPassword: 'Passw0rd',
      pendingGoogleEmail: 'person@newtheatre.org.uk',
    })

    const { user, how } = await resolveGoogleUser(profile())

    expect(how).toBe('pending')
    expect(user.id).toBe(account.id)
    expect(user.googleSub).toBe('google-sub-1')
    expect(user.pendingGoogleEmail).toBeNull()
    expect(user.email).toBe('personal@example.com')

    const audit = await db.select().from(schema.auditLog).all()
    expect(audit.map(a => a.action)).toContain('google.pending-link-consumed')
  })

  it('pending beats a plain email match on another account', async () => {
    await createUser({ email: 'person@newtheatre.org.uk', plainPassword: 'Passw0rd' })
    const directed = await createUser({
      email: 'other@example.com',
      plainPassword: 'Passw0rd',
      pendingGoogleEmail: 'person@newtheatre.org.uk',
    })

    const { user, how } = await resolveGoogleUser(profile())
    expect(how).toBe('pending')
    expect(user.id).toBe(directed.id)
  })

  it('clears a pending marker the sub match has made unreachable', async () => {
    const linked = await createUser({ email: 'person@newtheatre.org.uk', googleSub: 'google-sub-1' })
    const stranded = await createUser({
      email: 'other@example.com',
      plainPassword: 'Passw0rd',
      pendingGoogleEmail: 'person@newtheatre.org.uk',
    })

    const { user, how } = await resolveGoogleUser(profile())
    expect(how).toBe('sub')
    expect(user.id).toBe(linked.id)

    const row = await db.select().from(schema.users).where(eq(schema.users.id, stranded.id)).get()
    expect(row!.pendingGoogleEmail).toBeNull()
  })

  it('leaves the marker alone when the linked account is disabled', async () => {
    const linked = await createUser({ email: 'person@newtheatre.org.uk', googleSub: 'google-sub-1' })
    await db.update(schema.users).set({ disabled: true }).where(eq(schema.users.id, linked.id))
    const other = await createUser({
      email: 'other@example.com',
      plainPassword: 'Passw0rd',
      pendingGoogleEmail: 'person@newtheatre.org.uk',
    })

    await resolveGoogleUser(profile())

    // A rejected sign-in leaves no trace anywhere (docs/api-reference.md).
    const row = await db.select().from(schema.users).where(eq(schema.users.id, other.id)).get()
    expect(row!.pendingGoogleEmail).toBe('person@newtheatre.org.uk')
  })

  it('email match links and verifies: including claiming a shadow account', async () => {
    const shadow = await createUser({ email: 'person@newtheatre.org.uk' }) // password NULL

    const { user, how } = await resolveGoogleUser(profile())

    expect(how).toBe('email')
    expect(user.id).toBe(shadow.id)
    expect(user.googleSub).toBe('google-sub-1')
    expect(user.verified).toBe(true) // Google verified this exact address
  })

  it('second sign-in resolves by sub without touching the row', async () => {
    const first = await resolveGoogleUser(profile())
    const second = await resolveGoogleUser(profile())

    expect(second.how).toBe('sub')
    expect(second.user.id).toBe(first.user.id)

    const all = await db.select().from(schema.users)
      .where(eq(schema.users.googleSub, 'google-sub-1')).all()
    expect(all).toHaveLength(1)
  })
})
