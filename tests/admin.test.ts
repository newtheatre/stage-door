import { describe, expect, it } from 'vitest'
import { db, schema } from '@nuxthub/db'
import { eq } from 'drizzle-orm'
import rolesHandler from '../server/api/users/[id]/roles.put'
import disableHandler from '../server/api/users/[id]/disable.post'
import forceLogoutHandler from '../server/api/users/[id]/force-logout.post'
import pendingGoogleHandler from '../server/api/users/[id]/pending-google.put'
import unlinkGoogleHandler from '../server/api/users/[id]/unlink-google.post'
import createUserHandler from '../server/api/users/index.post'
import { makeEvent, sentEmails } from './setup'
import type { FakeEvent } from './setup'
import { createUser, grantRole } from './helpers/users'

const putRoles = rolesHandler as unknown as (event: unknown) => Promise<unknown>
const disable = disableHandler as unknown as (event: unknown) => Promise<unknown>
const forceLogout = forceLogoutHandler as unknown as (event: unknown) => Promise<unknown>
const putPendingGoogle = pendingGoogleHandler as unknown as (event: unknown) => Promise<unknown>
const unlinkGoogle = unlinkGoogleHandler as unknown as (event: unknown) => Promise<unknown>
const adminCreate = createUserHandler as unknown as (event: unknown) => Promise<{ user: { id: string } }>

let adminCounter = 0

/** An event whose session belongs to a (fresh) auth:ADMIN. Unique per call. */
async function adminEvent(extra: Partial<FakeEvent> = {}): Promise<{ event: FakeEvent, adminId: string }> {
  adminCounter += 1
  const admin = await createUser({ email: `admin${adminCounter}@example.com`, plainPassword: 'Passw0rd', verified: true })
  await grantRole(admin.id, 'auth:ADMIN')

  const event = makeEvent(extra)
  await (globalThis as never as { setUserSession: (e: unknown, s: unknown) => Promise<unknown> })
    .setUserSession(event, {
      user: { id: admin.id, email: admin.email, name: admin.name, verified: true, guest: false, roles: ['auth:ADMIN'] },
      loggedInAt: Date.now(),
      refreshedAt: Date.now(),
      epoch: 0,
    })
  return { event, adminId: admin.id }
}

describe('admin guard', () => {
  it('rejects anonymous and non-admin sessions', async () => {
    const target = await createUser({ email: 'target@example.com' })

    await expect(putRoles(makeEvent({ params: { id: target.id }, body: { roles: [] } })))
      .rejects.toMatchObject({ statusCode: 401 })

    const nonAdmin = await createUser({ email: 'plain@example.com', plainPassword: 'Passw0rd' })
    const event = makeEvent({ params: { id: target.id }, body: { roles: [] } })
    await (globalThis as never as { setUserSession: (e: unknown, s: unknown) => Promise<unknown> })
      .setUserSession(event, {
        user: { id: nonAdmin.id, email: nonAdmin.email, name: nonAdmin.name, verified: false, guest: false, roles: [] },
        loggedInAt: Date.now(),
        refreshedAt: Date.now(),
        epoch: 0,
      })
    await expect(putRoles(event)).rejects.toMatchObject({ statusCode: 403 })
  })

  it('rejects an admin session with a stale epoch — force-logout bites instantly here', async () => {
    const { event, adminId } = await adminEvent()
    await db.update(schema.users).set({ sessionEpoch: 5 }).where(eq(schema.users.id, adminId))

    const target = await createUser({ email: 'target@example.com' })
    event.params = { id: target.id }
    event.body = { roles: [] }

    await expect(putRoles(event)).rejects.toMatchObject({ statusCode: 401 })
  })
})

describe('admin user operations', () => {
  it('replaces the role set, validates format, and audits the change', async () => {
    const target = await createUser({ email: 'target@example.com', plainPassword: 'Passw0rd' })
    await grantRole(target.id, 'proscenium:ADMIN')

    const { event, adminId } = await adminEvent({
      params: { id: target.id },
      body: { roles: ['rooms:ADMIN', 'proscenium:BOX_OFFICE'] },
    })
    await putRoles(event)

    const roles = await db.select().from(schema.userRoles)
      .where(eq(schema.userRoles.userId, target.id)).all()
    expect(roles.map(r => r.role).sort()).toEqual(['proscenium:BOX_OFFICE', 'rooms:ADMIN'])

    const [entry] = await db.select().from(schema.auditLog).all()
    expect(entry).toMatchObject({ actorUserId: adminId, action: 'user.roles-changed', target: target.id })

    // Bad format rejected by validation.
    const bad = await adminEvent({ params: { id: target.id }, body: { roles: ['not a role'] } })
    await expect(putRoles(bad.event)).rejects.toThrow()
  })

  it('disable blocks the account and bumps its epoch; cannot disable yourself', async () => {
    const target = await createUser({ email: 'target@example.com', plainPassword: 'Passw0rd' })

    const { event, adminId } = await adminEvent({ params: { id: target.id } })
    await disable(event)

    const updated = await db.select().from(schema.users).where(eq(schema.users.id, target.id)).get()
    expect(updated!.disabled).toBe(true)
    expect(updated!.sessionEpoch).toBe(1)

    const self = await adminEvent({ params: {} })
    self.event.params = { id: self.adminId }
    await expect(disable(self.event)).rejects.toMatchObject({ statusCode: 400 })
    void adminId
  })

  it('force-logout bumps the epoch and audits', async () => {
    const target = await createUser({ email: 'target@example.com', plainPassword: 'Passw0rd' })
    const { event } = await adminEvent({ params: { id: target.id } })

    await forceLogout(event)

    const updated = await db.select().from(schema.users).where(eq(schema.users.id, target.id)).get()
    expect(updated!.sessionEpoch).toBe(1)
    const audit = await db.select().from(schema.auditLog).all()
    expect(audit.map(a => a.action)).toContain('user.force-logout')
  })

  it('admin-create sends a set-password email, never returns a password', async () => {
    const { event } = await adminEvent({
      body: { email: 'newbie@example.com', name: 'New Person', roles: ['rooms:ADMIN'] },
    })

    const result = await adminCreate(event)

    // The view exposes hasPassword (a boolean) but never a password value.
    expect(result.user).not.toHaveProperty('password')
    expect(sentEmails).toEqual([{ kind: 'reset', to: 'newbie@example.com', token: expect.any(String) }])

    const reset = await db.select().from(schema.passwordResets).all()
    // Admin-created: 24h token, not the 1h self-service one.
    const hours = (reset[0]!.expiresAt.getTime() - Date.now()) / 3_600_000
    expect(hours).toBeGreaterThan(23)
  })

  it('pending-google validates domain and uniqueness', async () => {
    const target = await createUser({ email: 'personal@example.com', plainPassword: 'Passw0rd' })

    // Wrong domain.
    const wrong = await adminEvent({ params: { id: target.id }, body: { email: 'x@gmail.com' } })
    await expect(putPendingGoogle(wrong.event)).rejects.toMatchObject({ statusCode: 400 })

    // Happy path.
    const ok = await adminEvent({ params: { id: target.id }, body: { email: 'person@newtheatre.org.uk' } })
    await putPendingGoogle(ok.event)
    const updated = await db.select().from(schema.users).where(eq(schema.users.id, target.id)).get()
    expect(updated!.pendingGoogleEmail).toBe('person@newtheatre.org.uk')

    // Already pending on another account.
    const other = await createUser({ email: 'other@example.com', plainPassword: 'Passw0rd' })
    const clash = await adminEvent({ params: { id: other.id }, body: { email: 'person@newtheatre.org.uk' } })
    await expect(putPendingGoogle(clash.event)).rejects.toMatchObject({ statusCode: 409 })
  })

  it('refuses to unlink Google when it is the only login method', async () => {
    const ssoOnly = await createUser({ email: 'sso@example.com', googleSub: 'sub-1' })
    const { event } = await adminEvent({ params: { id: ssoOnly.id } })

    await expect(unlinkGoogle(event)).rejects.toMatchObject({ statusCode: 400 })

    const withPassword = await createUser({ email: 'both@example.com', plainPassword: 'Passw0rd', googleSub: 'sub-2' })
    const ok = await adminEvent({ params: { id: withPassword.id } })
    await unlinkGoogle(ok.event)
    const updated = await db.select().from(schema.users).where(eq(schema.users.id, withPassword.id)).get()
    expect(updated!.googleSub).toBeNull()
  })
})
