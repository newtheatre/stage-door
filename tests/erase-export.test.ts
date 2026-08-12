import { describe, expect, it } from 'vitest'
import { db, schema } from '@nuxthub/db'
import { eq } from 'drizzle-orm'
import { eraseUser } from '../server/utils/erase'
import { exportUser } from '../server/utils/exportUser'
import { fetchMock } from './setup'
import { createUser, grantRole } from './helpers/users'

function hooksSucceed() {
  fetchMock.mockResolvedValue({ ok: true })
}

describe('eraseUser — anonymise, never delete (ADR-0008)', () => {
  it('rewrites identity, strips credentials/roles/tokens, bumps epoch, calls every hook', async () => {
    // A service token per app so hook bearers resolve.
    await db.insert(schema.serviceTokens).values([
      { name: 'proscenium', tokenHash: 'hash-p' },
      { name: 'rooms', tokenHash: 'hash-r' },
    ])
    hooksSucceed()

    const user = await createUser({
      email: 'victim@example-user.co.uk',
      plainPassword: 'Passw0rd',
      googleSub: 'sub-1',
      verified: true,
    })
    await grantRole(user.id, 'rooms:ADMIN')
    await db.insert(schema.passwordResets).values({ userId: user.id, token: 't1', expiresAt: new Date(Date.now() + 60_000) })

    const result = await eraseUser(user.id, { id: 'admin-1', via: 'admin' })

    expect(result.complete).toBe(true)
    expect(result.alreadyErased).toBe(false)

    const erased = await db.select().from(schema.users).where(eq(schema.users.id, user.id)).get()
    expect(erased!.email).toBe(`deleted-${user.id}@anonymised.invalid`)
    expect(erased!.name).toBe('Deleted user')
    expect(erased!.password).toBeNull()
    expect(erased!.googleSub).toBeNull()
    expect(erased!.verified).toBe(false)
    expect(erased!.disabled).toBe(true)
    expect(erased!.sessionEpoch).toBe(1) // live sessions die at refresh

    expect(await db.select().from(schema.userRoles).where(eq(schema.userRoles.userId, user.id)).all()).toHaveLength(0)
    expect(await db.select().from(schema.passwordResets).where(eq(schema.passwordResets.userId, user.id)).all()).toHaveLength(0)

    // Both apps' anonymise hooks called with the stored hash as bearer.
    expect(fetchMock).toHaveBeenCalledTimes(2)
    const urls = fetchMock.mock.calls.map(c => c[0])
    expect(urls).toContain('https://newtheatre.org.uk/api/_hooks/auth/anonymise')
    expect(urls).toContain('https://rooms.newtheatre.org.uk/api/_hooks/auth/anonymise')
    expect(fetchMock.mock.calls[0]![1].headers.Authorization).toMatch(/^Bearer hash-/)

    const audit = await db.select().from(schema.auditLog).all()
    expect(audit.map(a => a.action)).toContain('user.erased')
  })

  it('reports incomplete when a hook fails, and a re-run retries idempotently', async () => {
    await db.insert(schema.serviceTokens).values([
      { name: 'proscenium', tokenHash: 'hash-p' },
      { name: 'rooms', tokenHash: 'hash-r' },
    ])
    const user = await createUser({ email: 'victim@example-user.co.uk', plainPassword: 'Passw0rd' })

    fetchMock.mockImplementation((url: string) =>
      url.includes('rooms') ? Promise.reject(new Error('rooms down')) : Promise.resolve({ ok: true }))

    const first = await eraseUser(user.id, { id: 'admin-1', via: 'admin' })
    expect(first.complete).toBe(false)
    expect(first.hooks.find(h => h.app === 'rooms')!.ok).toBe(false)

    const audit1 = await db.select().from(schema.auditLog).all()
    expect(audit1.map(a => a.action)).toContain('user.erase-incomplete')

    // Identity is already anonymised despite the failed hook.
    const erased = await db.select().from(schema.users).where(eq(schema.users.id, user.id)).get()
    expect(erased!.email).toBe(`deleted-${user.id}@anonymised.invalid`)

    // Retry once rooms is back: hooks re-called, now complete.
    hooksSucceed()
    const second = await eraseUser(user.id, { id: 'admin-1', via: 'admin' })
    expect(second.alreadyErased).toBe(true)
    expect(second.complete).toBe(true)
  })
})

describe('exportUser — the subject-access bundle', () => {
  it('bundles the auth record, roles, legacy ids, audit trail, and app data', async () => {
    await db.insert(schema.serviceTokens).values([
      { name: 'proscenium', tokenHash: 'hash-p' },
      { name: 'rooms', tokenHash: 'hash-r' },
    ])
    const user = await createUser({ email: 'subject@example-user.co.uk', plainPassword: 'Passw0rd', verified: true })
    await grantRole(user.id, 'rooms:ADMIN')
    await db.insert(schema.legacyIds).values({ userId: user.id, source: 'rooms', legacyId: 'old-uuid' })

    fetchMock.mockImplementation((url: string) => Promise.resolve({
      data: url.includes('rooms') ? { bookings: [1, 2] } : { reservations: [3] },
    }))

    const bundle = await exportUser(user.id)

    expect(bundle.account).toMatchObject({
      id: user.id,
      email: 'subject@example-user.co.uk',
      legacyIds: [{ source: 'rooms', legacyId: 'old-uuid' }],
    })
    // Roles export as full grants (expired included) — ADR-0011.
    expect(bundle.account.roles).toHaveLength(1)
    expect(bundle.account.roles[0]).toMatchObject({ role: 'rooms:ADMIN', expiresAt: null, expired: false })
    expect(bundle.account).not.toHaveProperty('password')
    expect(bundle.apps.rooms).toEqual({ bookings: [1, 2] })
    expect(bundle.apps.proscenium).toEqual({ reservations: [3] })
  })

  it('surfaces a hook failure without sinking the export', async () => {
    await db.insert(schema.serviceTokens).values([
      { name: 'proscenium', tokenHash: 'hash-p' },
      { name: 'rooms', tokenHash: 'hash-r' },
    ])
    const user = await createUser({ email: 'subject@example-user.co.uk', plainPassword: 'Passw0rd' })

    fetchMock.mockImplementation((url: string) =>
      url.includes('rooms') ? Promise.reject(new Error('rooms down')) : Promise.resolve({ data: { reservations: [] } }))

    const bundle = await exportUser(user.id)
    expect(bundle.apps.proscenium).toEqual({ reservations: [] })
    expect(JSON.stringify(bundle.apps.rooms)).toContain('export unavailable')
  })
})
