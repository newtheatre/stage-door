import { describe, expect, it } from 'vitest'
import { db, schema } from '@nuxthub/db'
import { eq, sql } from 'drizzle-orm'
import refreshGetHandler from '../server/api/session/refresh.get'
import refreshPostHandler from '../server/api/session/refresh.post'
import loginHandler from '../server/api/auth/login.post'
import { makeEvent, sealedSession } from './setup'
import type { FakeEvent } from './setup'
import { createUser, grantRole } from './helpers/users'

const refreshGet = refreshGetHandler as unknown as (event: unknown) => Promise<unknown>
const refreshPost = refreshPostHandler as unknown as (event: unknown) => Promise<{ user: { roles: string[] } }>
const login = loginHandler as unknown as (event: unknown) => Promise<unknown>

/** Log in for real so the event carries a genuine sealed session. */
async function loggedInEvent(email: string, extra: Partial<FakeEvent> = {}): Promise<FakeEvent> {
  const event = makeEvent({ body: { email, password: 'Passw0rd' }, ...extra })
  await login(event)
  return event
}

describe('session refresh', () => {
  it('re-reads roles granted after login (the 15-minute propagation path)', async () => {
    const user = await createUser({ email: 'alice@example.com', plainPassword: 'Passw0rd' })
    const event = await loggedInEvent('alice@example.com')
    expect((sealedSession(event)!.user as { roles: string[] }).roles).toEqual([])

    await grantRole(user.id, 'rooms:ADMIN')

    const result = await refreshPost(event)
    expect(result.user.roles).toEqual(['rooms:ADMIN'])
    expect((sealedSession(event)!.user as { roles: string[] }).roles).toEqual(['rooms:ADMIN'])
  })

  it('an expired grant vanishes at refresh without the row being deleted', async () => {
    const user = await createUser({ email: 'alice@example.com', plainPassword: 'Passw0rd' })
    await grantRole(user.id, 'rooms:ADMIN', { expiresAt: new Date(Date.now() + 60_000) })

    const event = await loggedInEvent('alice@example.com')
    expect((sealedSession(event)!.user as { roles: string[] }).roles).toEqual(['rooms:ADMIN'])

    // The grant expires (row untouched otherwise)…
    await db.update(schema.userRoles)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(schema.userRoles.userId, user.id))

    // …and the next refresh seals a session without it.
    const result = await refreshPost(event)
    expect(result.user.roles).toEqual([])

    const rows = await db.select().from(schema.userRoles).where(eq(schema.userRoles.userId, user.id)).all()
    expect(rows).toHaveLength(1) // history intact: read-time enforcement, not deletion
  })

  it('preserves loggedInAt but updates refreshedAt', async () => {
    await createUser({ email: 'alice@example.com', plainPassword: 'Passw0rd' })
    const event = await loggedInEvent('alice@example.com')
    const before = sealedSession(event)!
    const loggedInAt = before.loggedInAt

    await new Promise(resolve => setTimeout(resolve, 5))
    await refreshPost(event)

    const after = sealedSession(event)!
    expect(after.loggedInAt).toBe(loggedInAt)
    expect(after.refreshedAt as number).toBeGreaterThanOrEqual(before.refreshedAt as number)
  })

  it('rejects a stale epoch (force-logout) and clears the session', async () => {
    const user = await createUser({ email: 'alice@example.com', plainPassword: 'Passw0rd' })
    const event = await loggedInEvent('alice@example.com')

    await db.update(schema.users)
      .set({ sessionEpoch: sql`${schema.users.sessionEpoch} + 1` })
      .where(eq(schema.users.id, user.id))

    await expect(refreshPost(event)).rejects.toMatchObject({ statusCode: 401 })
    expect(sealedSession(event)).toBeUndefined()
  })

  it('rejects a disabled user and clears the session', async () => {
    const user = await createUser({ email: 'alice@example.com', plainPassword: 'Passw0rd' })
    const event = await loggedInEvent('alice@example.com')

    await db.update(schema.users).set({ disabled: true }).where(eq(schema.users.id, user.id))

    await expect(refreshPost(event)).rejects.toMatchObject({ statusCode: 401 })
    expect(sealedSession(event)).toBeUndefined()
  })

  it('rejects a deleted user and clears the session', async () => {
    const user = await createUser({ email: 'alice@example.com', plainPassword: 'Passw0rd' })
    const event = await loggedInEvent('alice@example.com')

    await db.delete(schema.users).where(eq(schema.users.id, user.id))

    await expect(refreshPost(event)).rejects.toMatchObject({ statusCode: 401 })
    expect(sealedSession(event)).toBeUndefined()
  })

  it('GET bounces to the validated target on success, login on failure', async () => {
    await createUser({ email: 'alice@example.com', plainPassword: 'Passw0rd' })

    const good = await loggedInEvent('alice@example.com', {
      query: { redirect: 'https://rooms.newtheatre.org.uk/admin' },
    })
    await refreshGet(good)
    expect(good.redirectedTo?.url).toBe('https://rooms.newtheatre.org.uk/admin')

    // Evil target: validated before use, even on the success path.
    const evil = await loggedInEvent('alice@example.com', {
      query: { redirect: 'https://evil.com' },
    })
    await refreshGet(evil)
    expect(evil.redirectedTo?.url).toBe('https://newtheatre.org.uk')

    // No session at all → login, with the target folded in.
    const anonymous = makeEvent({ query: { redirect: 'https://rooms.newtheatre.org.uk/x' } })
    await refreshGet(anonymous)
    expect(anonymous.redirectedTo?.url).toBe(
      `/login?redirect=${encodeURIComponent('https://rooms.newtheatre.org.uk/x')}`,
    )
  })
})
