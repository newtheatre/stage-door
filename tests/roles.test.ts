import { describe, expect, it } from 'vitest'
import { db, schema } from '@nuxthub/db'
import { and, eq } from 'drizzle-orm'
import { loadRoles, loadRoleGrants } from '../server/utils/session'
import { formatDate } from '../shared/utils/formatDate'
import { nextCommitteeYearEnd } from '../server/utils/rolesConfig'
import rolesHandler from '../server/api/users/[id]/roles.put'
import definitionsListHandler from '../server/api/role-definitions/index.get'
import definitionsCreateHandler from '../server/api/role-definitions/index.post'
import definitionsDeleteHandler from '../server/api/role-definitions/[id].delete'
import { makeEvent } from './setup'
import type { FakeEvent } from './setup'
import { createUser, grantRole, enrolTotp, defineRole } from './helpers/users'

const putRoles = rolesHandler as unknown as (event: unknown) => Promise<unknown>
const listDefinitions = definitionsListHandler as unknown as (event: unknown) => Promise<{ definitions: { id: string, defaultExpiresAt: number | null }[] }>
const createDefinition = definitionsCreateHandler as unknown as (event: unknown) => Promise<{ definition: { id: string } }>
const deleteDefinition = definitionsDeleteHandler as unknown as (event: unknown) => Promise<unknown>

const DAY = 24 * 60 * 60 * 1000

let adminCounter = 100

async function adminEvent(extra: Partial<FakeEvent> = {}): Promise<{ event: FakeEvent, adminId: string }> {
  adminCounter += 1
  const admin = await createUser({ email: `roles-admin${adminCounter}@example-user.co.uk`, plainPassword: 'Passw0rd', verified: true })
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

describe('read-time expiry enforcement (ADR-0011)', () => {
  it('loadRoles returns permanent and future-dated grants, never expired ones', async () => {
    const user = await createUser({ email: 'holder@example-user.co.uk', plainPassword: 'Passw0rd' })
    await grantRole(user.id, 'rooms:ADMIN') // permanent
    await grantRole(user.id, 'proscenium:BOX_OFFICE', { expiresAt: new Date(Date.now() + 30 * DAY) })
    await grantRole(user.id, 'proscenium:MANAGER', { expiresAt: new Date(Date.now() - DAY) })

    expect((await loadRoles(user.id)).sort()).toEqual(['proscenium:BOX_OFFICE', 'rooms:ADMIN'])

    const grants = await loadRoleGrants(user.id)
    expect(grants).toHaveLength(3)
    expect(grants.find(g => g.role === 'proscenium:MANAGER')!.expired).toBe(true)
    expect(grants.find(g => g.role === 'rooms:ADMIN')!.expired).toBe(false)
  })

  it('the admin guard rejects a session whose only auth:ADMIN grant has expired', async () => {
    const { event, adminId } = await adminEvent()
    await db.update(schema.userRoles)
      .set({ expiresAt: new Date(Date.now() - DAY) })
      .where(eq(schema.userRoles.userId, adminId))

    const target = await createUser({ email: 'target@example-user.co.uk' })
    event.params = { id: target.id }
    event.body = { roles: [] }

    await expect(putRoles(event)).rejects.toMatchObject({ statusCode: 403 })
  })
})

// 22:59:59.999Z, not 23: 31 July is inside BST, so the last instant of that
// London day is an hour earlier in UTC. Rendering it must say 31 July.
describe('nextCommitteeYearEnd', () => {
  it('October rolls to the following 31 July', () => {
    const result = nextCommitteeYearEnd(new Date(Date.UTC(2026, 9, 15)))
    expect(result.toISOString()).toBe('2027-07-31T22:59:59.999Z')
    expect(formatDate(result)).toBe('31 Jul 2027')
  })

  it('1 August rolls to the NEXT year (the year end just passed)', () => {
    const result = nextCommitteeYearEnd(new Date(Date.UTC(2026, 7, 1)))
    expect(result.toISOString()).toBe('2027-07-31T22:59:59.999Z')
  })

  it('midday on 31 July resolves to that same evening', () => {
    const result = nextCommitteeYearEnd(new Date(Date.UTC(2026, 6, 31, 12)))
    expect(result.toISOString()).toBe('2026-07-31T22:59:59.999Z')
  })
})

describe('role definitions', () => {
  it('creates, computes defaults, rejects duplicates, and deletes without touching grants', async () => {
    // committee-year default computes exactly nextCommitteeYearEnd.
    const { event } = await adminEvent({
      body: { namespace: 'proscenium', role: 'BOX_OFFICE', description: 'Sell tickets', defaultExpiry: { kind: 'committee-year' } },
    })
    const created = await createDefinition(event)

    // days default computes now + n days.
    const daysEvent = await adminEvent({
      body: { namespace: 'photos', role: 'UPLOADER', description: 'Upload photos', defaultExpiry: { kind: 'days', days: 30 } },
    })
    await createDefinition(daysEvent.event)

    const list = await listDefinitions((await adminEvent()).event)
    expect(list.definitions).toHaveLength(2)
    const committeeYear = list.definitions.find(d => d.id === created.definition.id)!
    expect(committeeYear.defaultExpiresAt).toBe(nextCommitteeYearEnd().getTime())
    const days = list.definitions.find(d => d.id !== created.definition.id)!
    expect(days.defaultExpiresAt).toBeGreaterThan(Date.now() + 29 * DAY)
    expect(days.defaultExpiresAt).toBeLessThanOrEqual(Date.now() + 30 * DAY)

    // Duplicate rejected.
    const dupe = await adminEvent({
      body: { namespace: 'proscenium', role: 'BOX_OFFICE', description: 'Again', defaultExpiry: { kind: 'none' } },
    })
    await expect(createDefinition(dupe.event)).rejects.toMatchObject({ statusCode: 409 })

    // Bad format rejected by validation.
    const bad = await adminEvent({
      body: { namespace: 'Proscenium', role: 'box', description: 'x', defaultExpiry: { kind: 'none' } },
    })
    await expect(createDefinition(bad.event)).rejects.toThrow()

    // Deleting a definition leaves grants alone.
    const holder = await createUser({ email: 'holder@example-user.co.uk' })
    await grantRole(holder.id, 'proscenium:BOX_OFFICE')
    const del = await adminEvent({ params: { id: created.definition.id } })
    await deleteDefinition(del.event)
    expect(await loadRoles(holder.id)).toEqual(['proscenium:BOX_OFFICE'])
  })
})

describe('PUT /api/users/:id/roles — grant diff semantics', () => {
  it('accepts bare strings (back-compat) as permanent grants', async () => {
    await defineRole('rooms', 'ADMIN')
    const target = await createUser({ email: 'target@example-user.co.uk' })
    const { event, adminId } = await adminEvent({
      params: { id: target.id },
      body: { roles: ['rooms:ADMIN'] },
    })
    await putRoles(event)

    const [row] = await db.select().from(schema.userRoles)
      .where(eq(schema.userRoles.userId, target.id)).all()
    expect(row!.expiresAt).toBeNull()
    expect(row!.grantedBy).toBe(adminId)
    expect(row!.grantedAt).not.toBeNull()
  })

  it('persists expiry and note from grant objects', async () => {
    await defineRole('proscenium', 'BOX_OFFICE')
    const target = await createUser({ email: 'target@example-user.co.uk' })
    const expiresAt = Date.now() + 90 * DAY
    const { event } = await adminEvent({
      params: { id: target.id },
      body: { roles: [{ role: 'proscenium:BOX_OFFICE', expiresAt, note: 'autumn season' }] },
    })
    await putRoles(event)

    const [row] = await db.select().from(schema.userRoles)
      .where(eq(schema.userRoles.userId, target.id)).all()
    expect(row!.expiresAt!.getTime()).toBe(expiresAt)
    expect(row!.note).toBe('autumn season')
  })

  it('is a diff: unchanged grants keep provenance; changed expiry clears the warning flag', async () => {
    const target = await createUser({ email: 'target@example-user.co.uk' })
    const originalGrantedAt = new Date(Date.now() - 100 * DAY)
    await db.insert(schema.userRoles).values([
      { userId: target.id, role: 'rooms:ADMIN', grantedAt: originalGrantedAt, grantedBy: 'original-admin', expiryWarnedAt: new Date() },
      { userId: target.id, role: 'proscenium:MANAGER', expiresAt: new Date(Date.now() + 10 * DAY), grantedAt: originalGrantedAt, grantedBy: 'original-admin', expiryWarnedAt: new Date() },
    ])

    const newExpiry = Date.now() + 200 * DAY
    const { event, adminId } = await adminEvent({
      params: { id: target.id },
      body: { roles: [
        'rooms:ADMIN', // unchanged (permanent)
        { role: 'proscenium:MANAGER', expiresAt: newExpiry }, // renewed
      ] },
    })
    await putRoles(event)

    const unchanged = await db.select().from(schema.userRoles)
      .where(and(eq(schema.userRoles.userId, target.id), eq(schema.userRoles.role, 'rooms:ADMIN'))).get()
    expect(unchanged!.grantedAt!.getTime()).toBe(originalGrantedAt.getTime())
    expect(unchanged!.grantedBy).toBe('original-admin')
    expect(unchanged!.expiryWarnedAt).not.toBeNull() // untouched

    const renewed = await db.select().from(schema.userRoles)
      .where(and(eq(schema.userRoles.userId, target.id), eq(schema.userRoles.role, 'proscenium:MANAGER'))).get()
    expect(renewed!.expiresAt!.getTime()).toBe(newExpiry)
    expect(renewed!.expiryWarnedAt).toBeNull() // renewal re-arms the warning
    expect(renewed!.grantedBy).toBe(adminId) // fresh act of granting
  })

  it('refuses to create a grant with no definition, but leaves held ones editable (ADR-0014)', async () => {
    const target = await createUser({ email: 'undefined-role@example-user.co.uk' })
    // ticketing:* — the dormant legacy namespace deliberately has no
    // definitions (ADR-0010), and history like it must stay manageable.
    await grantRole(target.id, 'ticketing:LEGACY')

    // A brand-new undefined role is refused outright…
    const refused = await adminEvent({
      params: { id: target.id },
      body: { roles: ['ticketing:LEGACY', 'madeup:ROLE'] },
    })
    await expect(putRoles(refused.event)).rejects.toMatchObject({ statusCode: 400 })

    // …but renewing/annotating the definition-less grant they already hold
    // is fine, as is removing it.
    const renew = await adminEvent({
      params: { id: target.id },
      body: { roles: [{ role: 'ticketing:LEGACY', expiresAt: Date.now() + 30 * DAY, note: 'winding down' }] },
    })
    await putRoles(renew.event)
    const row = await db.select().from(schema.userRoles)
      .where(and(eq(schema.userRoles.userId, target.id), eq(schema.userRoles.role, 'ticketing:LEGACY'))).get()
    expect(row!.note).toBe('winding down')

    const remove = await adminEvent({ params: { id: target.id }, body: { roles: [] } })
    await putRoles(remove.event)
    expect(await db.select().from(schema.userRoles).where(eq(schema.userRoles.userId, target.id)).all()).toHaveLength(0)
  })

  it('removes grants absent from the body and rejects duplicates', async () => {
    await defineRole('rooms', 'ADMIN')
    const target = await createUser({ email: 'target@example-user.co.uk' })
    await grantRole(target.id, 'rooms:ADMIN')

    const { event } = await adminEvent({ params: { id: target.id }, body: { roles: [] } })
    await putRoles(event)
    expect(await db.select().from(schema.userRoles).where(eq(schema.userRoles.userId, target.id)).all()).toHaveLength(0)

    const dupe = await adminEvent({
      params: { id: target.id },
      body: { roles: ['rooms:ADMIN', { role: 'rooms:ADMIN', expiresAt: null, note: null }] },
    })
    await expect(putRoles(dupe.event)).rejects.toMatchObject({ statusCode: 400 })
  })
})
