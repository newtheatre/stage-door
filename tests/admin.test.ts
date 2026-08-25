import { describe, expect, it } from 'bun:test'
import { db, schema } from '@nuxthub/db'
import { eq } from 'drizzle-orm'
import rolesHandler from '../server/api/users/[id]/roles.put'
import disableHandler from '../server/api/users/[id]/disable.post'
import forceLogoutHandler from '../server/api/users/[id]/force-logout.post'
import pendingGoogleHandler from '../server/api/users/[id]/pending-google.put'
import unlinkGoogleHandler from '../server/api/users/[id]/unlink-google.post'
import createUserHandler from '../server/api/users/index.post'
import putUserHandler from '../server/api/users/[id]/index.put'
import enableUserHandler from '../server/api/users/[id]/enable.post'
import adminResetPasswordHandler from '../server/api/users/[id]/reset-password.post'
import clearPasswordHandler from '../server/api/users/[id]/clear-password.post'
import mfaResetAdminHandler from '../server/api/users/[id]/mfa-reset.post'
import listUsersHandler from '../server/api/users/index.get'
import selfEraseHandler from '../server/api/account/erase.post'
import { makeEvent, sentEmails } from './setup'
import type { FakeEvent } from './setup'
import { createUser, grantRole, enrolTotp, defineRole } from './helpers/users'

const putRoles = rolesHandler as unknown as (event: unknown) => Promise<unknown>
const disable = disableHandler as unknown as (event: unknown) => Promise<unknown>
const forceLogout = forceLogoutHandler as unknown as (event: unknown) => Promise<unknown>
const putPendingGoogle = pendingGoogleHandler as unknown as (event: unknown) => Promise<unknown>
const unlinkGoogle = unlinkGoogleHandler as unknown as (event: unknown) => Promise<unknown>
const adminCreate = createUserHandler as unknown as (event: unknown) => Promise<{ user: { id: string } }>
const listUsers = listUsersHandler as unknown as (event: unknown) => Promise<unknown>
const selfErase = selfEraseHandler as unknown as (event: unknown) => Promise<unknown>
const putUser = putUserHandler as unknown as (event: unknown) => Promise<unknown>
const enableUser = enableUserHandler as unknown as (event: unknown) => Promise<unknown>
const adminResetPassword = adminResetPasswordHandler as unknown as (event: unknown) => Promise<unknown>
const clearPassword = clearPasswordHandler as unknown as (event: unknown) => Promise<unknown>
const mfaResetAdmin = mfaResetAdminHandler as unknown as (event: unknown) => Promise<unknown>
const unlinkGoogleAdmin = unlinkGoogle

let adminCounter = 0

/** An event whose session belongs to a (fresh) auth:ADMIN. Unique per call. */
async function adminEvent(extra: Partial<FakeEvent> = {}): Promise<{ event: FakeEvent, adminId: string }> {
  adminCounter += 1
  const admin = await createUser({ email: `admin${adminCounter}@example.com`, plainPassword: 'Passw0rd', verified: true })
  await grantRole(admin.id, 'auth:ADMIN')
  await enrolTotp(admin.id)

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

  it('rejects an admin session with a stale epoch: force-logout bites instantly here', async () => {
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
    await defineRole('rooms', 'ADMIN')
    await defineRole('proscenium', 'BOX_OFFICE')
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
    await defineRole('rooms', 'ADMIN')
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

  it('admin-create refuses an undefined role, like the grant editor does (ADR-0014)', async () => {
    const { event } = await adminEvent({
      body: { email: 'nope@example.com', name: 'No Person', roles: ['prosenium:BOX_OFFICE'] },
    })

    await expect(adminCreate(event)).rejects.toMatchObject({ statusCode: 400 })

    // Refused before the row was written, so no half-created user is left.
    const users = await db.select().from(schema.users)
      .where(eq(schema.users.email, 'nope@example.com')).all()
    expect(users).toHaveLength(0)
  })

  it('admin-create refuses a Workspace address before writing anything (ADR-0012)', async () => {
    await defineRole('proscenium', 'ADMIN')
    const { event } = await adminEvent({
      body: { email: 'president@newtheatre.org.uk', name: 'The President', roles: ['proscenium:ADMIN'] },
    })

    await expect(adminCreate(event)).rejects.toMatchObject({ statusCode: 403 })

    // No orphan row, no grants it would have carried, no email.
    const users = await db.select().from(schema.users)
      .where(eq(schema.users.email, 'president@newtheatre.org.uk')).all()
    expect(users).toHaveLength(0)
    expect(await db.select().from(schema.userRoles).all()).toHaveLength(1) // the admin's own
    expect(sentEmails).toHaveLength(0)
  })

  it('admin-create refuses duplicate roles rather than failing on the unique index', async () => {
    await defineRole('rooms', 'ADMIN')
    const { event } = await adminEvent({
      body: { email: 'twice@example.com', name: 'Two Ice', roles: ['rooms:ADMIN', 'rooms:ADMIN'] },
    })

    await expect(adminCreate(event)).rejects.toMatchObject({ statusCode: 400 })

    const users = await db.select().from(schema.users)
      .where(eq(schema.users.email, 'twice@example.com')).all()
    expect(users).toHaveLength(0)
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

describe('the users list standing counts', () => {
  it('counts anonymised rows, workspace passwords and admins without MFA in one pass', async () => {
    // An admin with MFA: privileged, but not needing attention.
    const { event } = await adminEvent({ query: {} })

    // Workspace address holding a password (ADR-0012 rollout flag).
    const workspace = await createUser({ email: 'staff@newtheatre.org.uk', plainPassword: 'Passw0rd' })
    await defineRole('rooms', 'ADMIN')
    await grantRole(workspace.id, 'rooms:ADMIN')

    // A password admin with no second factor. Deliverable domain: the
    // example.com family reads as an anonymised placeholder here.
    const bare = await createUser({ email: 'bare@example-user.co.uk', plainPassword: 'Passw0rd' })
    await grantRole(bare.id, 'rooms:ADMIN')

    // An expired admin grant must not count: the predicate is active-only.
    const lapsed = await createUser({ email: 'lapsed@example-user.co.uk', plainPassword: 'Passw0rd' })
    await grantRole(lapsed.id, 'rooms:ADMIN', { expiresAt: new Date(Date.now() - 86_400_000) })

    // One anonymised placeholder, so the hidden count is not trivially zero.
    await createUser({ email: 'erased-abc@example.invalid' })

    const result = await listUsers(event) as {
      hiddenAnonymised: number
      needsAttention: { workspacePassword: number, adminNoMfa: number }
    }

    // The signed-in admin's address is in that family too, so it counts.
    expect(result.hiddenAnonymised).toBe(2)
    expect(result.needsAttention.workspacePassword).toBe(1)
    // workspace + bare, but not lapsed (expired) and not the enrolled admin.
    expect(result.needsAttention.adminNoMfa).toBe(2)
  })
})

describe('an erased account cannot be written back over', () => {
  async function erasedUser() {
    const user = await createUser({ email: 'gone@example.com', name: 'Gone' })
    await db.update(schema.users)
      .set({ email: `deleted-${user.id}@anonymised.invalid`, name: 'Deleted user', disabled: true })
      .where(eq(schema.users.id, user.id))
    return user
  }

  it('refuses to restore a name and address', async () => {
    const target = await erasedUser()
    const { event } = await adminEvent({ params: { id: target.id }, body: { name: 'Real Name', email: 'real@person.com' } })

    await expect(putUser(event)).rejects.toMatchObject({ statusCode: 400 })

    const row = await db.select().from(schema.users).where(eq(schema.users.id, target.id)).get()
    expect(row!.email).toBe(`deleted-${target.id}@anonymised.invalid`)
    expect(row!.name).toBe('Deleted user')
  })

  it('refuses to re-enable it', async () => {
    const target = await erasedUser()
    const { event } = await adminEvent({ params: { id: target.id } })

    await expect(enableUser(event)).rejects.toMatchObject({ statusCode: 400 })

    const row = await db.select().from(schema.users).where(eq(schema.users.id, target.id)).get()
    expect(row!.disabled).toBe(true)
  })

  it('refuses to mint it a set-password link', async () => {
    const target = await erasedUser()
    const { event } = await adminEvent({ params: { id: target.id } })

    await expect(adminResetPassword(event)).rejects.toMatchObject({ statusCode: 400 })
    expect(sentEmails).toHaveLength(0)
  })

  it('refuses to grant it roles, notes and all', async () => {
    const target = await erasedUser()
    await defineRole('rooms', 'ADMIN')
    const { event } = await adminEvent({
      params: { id: target.id },
      body: { roles: [{ role: 'rooms:ADMIN', expiresAt: null, note: 'Reinstated by request' }] },
    })

    await expect(putRoles(event)).rejects.toMatchObject({ statusCode: 400 })

    const granted = await db.select().from(schema.userRoles)
      .where(eq(schema.userRoles.userId, target.id)).all()
    expect(granted).toHaveLength(0)
  })

  it('refuses to point a real address at it as a pending Google link', async () => {
    const target = await erasedUser()
    const { event } = await adminEvent({
      params: { id: target.id },
      body: { email: 'alice@newtheatre.org.uk' },
    })

    await expect(putPendingGoogle(event)).rejects.toMatchObject({ statusCode: 400 })

    const row = await db.select().from(schema.users).where(eq(schema.users.id, target.id)).get()
    expect(row!.pendingGoogleEmail).toBeNull()
  })
})

describe('request bodies are bounded', () => {
  it('refuses a grant set past the cap, before any statement is issued', async () => {
    // Every role is defined, so the cap is the only thing left to reject it.
    for (let i = 0; i <= MAX_GRANTS_PER_REQUEST; i++) await defineRole('rooms', `ROLE_${i}`)
    const roles = Array.from({ length: MAX_GRANTS_PER_REQUEST + 1 }, (_, i) => `rooms:ROLE_${i}`)

    const target = await createUser({ email: 'bulk@example.com' })
    const { event } = await adminEvent({ params: { id: target.id }, body: { roles } })
    await expect(putRoles(event)).rejects.toThrow()

    // Nothing was written.
    const granted = await db.select().from(schema.userRoles)
      .where(eq(schema.userRoles.userId, target.id)).all()
    expect(granted).toHaveLength(0)
  })

  it('accepts a grant set exactly at the cap', async () => {
    for (let i = 0; i < MAX_GRANTS_PER_REQUEST; i++) await defineRole('rooms', `ROLE_${i}`)
    const roles = Array.from({ length: MAX_GRANTS_PER_REQUEST }, (_, i) => `rooms:ROLE_${i}`)

    const target = await createUser({ email: 'atcap@example.com' })
    const { event } = await adminEvent({ params: { id: target.id }, body: { roles } })
    await expect(putRoles(event)).resolves.toBeTruthy()
  })
})

describe('the last auth:ADMIN cannot be removed or dated', () => {
  it('refuses to drop the only live auth:ADMIN grant', async () => {
    await defineRole('auth', 'ADMIN')
    const { event, adminId } = await adminEvent({ body: { roles: [] } })
    event.params = { id: adminId }

    await expect(putRoles(event)).rejects.toMatchObject({ statusCode: 400 })

    const still = await db.select().from(schema.userRoles)
      .where(eq(schema.userRoles.userId, adminId)).all()
    expect(still.map(r => r.role)).toContain('auth:ADMIN')
  })

  it('refuses to give the only auth:ADMIN an expiry, which lapses into the same lockout', async () => {
    await defineRole('auth', 'ADMIN')
    const { event, adminId } = await adminEvent({
      body: { roles: [{ role: 'auth:ADMIN', expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000 }] },
    })
    event.params = { id: adminId }

    await expect(putRoles(event)).rejects.toMatchObject({ statusCode: 400 })
  })

  it('refuses when the only other holder is a disabled account', async () => {
    await defineRole('auth', 'ADMIN')
    const { event, adminId } = await adminEvent({ body: { roles: [] } })
    // The outgoing manager: disabled, but disable leaves the grant row behind.
    const gone = await createUser({ email: 'left-admin@example.com', disabled: true })
    await grantRole(gone.id, 'auth:ADMIN')
    event.params = { id: adminId }

    await expect(putRoles(event)).rejects.toMatchObject({ statusCode: 400 })

    const still = await db.select().from(schema.userRoles)
      .where(eq(schema.userRoles.userId, adminId)).all()
    expect(still.map(r => r.role)).toContain('auth:ADMIN')
  })

  it('refuses to let the last usable auth:ADMIN close their own account past a disabled holder', async () => {
    await defineRole('auth', 'ADMIN')
    const { event, adminId } = await adminEvent()
    const gone = await createUser({ email: 'left-admin2@example.com', disabled: true })
    await grantRole(gone.id, 'auth:ADMIN')
    const admin = await db.select().from(schema.users).where(eq(schema.users.id, adminId)).get()
    event.body = { confirmEmail: admin!.email, password: 'Passw0rd' }

    await expect(selfErase(event)).rejects.toMatchObject({ statusCode: 400 })
  })

  it('allows it once someone else holds auth:ADMIN', async () => {
    await defineRole('auth', 'ADMIN')
    const { event, adminId } = await adminEvent({ body: { roles: [] } })
    const peer = await createUser({ email: 'peer-admin@example.com' })
    await grantRole(peer.id, 'auth:ADMIN')
    event.params = { id: adminId }

    await expect(putRoles(event)).resolves.toBeTruthy()
  })

  // Erasure cannot be undone the way a role change can, so this is the one
  // path where losing the last admin means hand-editing production.
  it('refuses to let the only auth:ADMIN close their own account', async () => {
    await defineRole('auth', 'ADMIN')
    const { event, adminId } = await adminEvent()
    const admin = await db.select().from(schema.users).where(eq(schema.users.id, adminId)).get()
    event.body = { confirmEmail: admin!.email, password: 'Passw0rd' }

    await expect(selfErase(event)).rejects.toMatchObject({ statusCode: 400 })

    const still = await db.select().from(schema.users).where(eq(schema.users.id, adminId)).get()
    expect(still!.email).toBe(admin!.email)
    expect(still!.disabled).toBeFalsy()
  })

  it('lets an admin close their own account once someone else holds auth:ADMIN', async () => {
    await defineRole('auth', 'ADMIN')
    const { event, adminId } = await adminEvent()
    const peer = await createUser({ email: 'peer-admin2@example.com' })
    await grantRole(peer.id, 'auth:ADMIN')
    const admin = await db.select().from(schema.users).where(eq(schema.users.id, adminId)).get()
    event.body = { confirmEmail: admin!.email, password: 'Passw0rd' }

    await expect(selfErase(event)).resolves.toBeTruthy()
  })

  it('lets an ordinary member close their own account, even as the only admin looks on', async () => {
    await defineRole('auth', 'ADMIN')
    await adminEvent()
    const member = await createUser({ email: 'ordinary@example.com', plainPassword: 'Passw0rd', verified: true })
    const event = makeEvent({ body: { confirmEmail: member.email, password: 'Passw0rd' } })
    await (globalThis as never as { setUserSession: (e: unknown, s: unknown) => Promise<unknown> })
      .setUserSession(event, {
        user: { id: member.id, email: member.email, name: member.name, verified: true, guest: false, roles: [] },
        loggedInAt: Date.now(),
        refreshedAt: Date.now(),
        epoch: 0,
      })

    await expect(selfErase(event)).resolves.toBeTruthy()
  })
})

describe('admin routes state whether they may be aimed at yourself', () => {
  it.each([
    ['clear-password', () => clearPassword],
    ['mfa-reset', () => mfaResetAdmin],
    ['unlink-google', () => unlinkGoogleAdmin],
  ])('%s refuses a self-target, and says why', async (_name, handler) => {
    const { event, adminId } = await adminEvent({ params: { id: '' } })
    event.params = { id: adminId }

    // The message proves it was the self-target guard, not an adjacent one.
    await expect(handler()(event)).rejects.toMatchObject({
      statusCode: 400,
      statusMessage: expect.stringContaining('your own'),
    })
  })
})
