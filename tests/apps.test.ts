import { describe, expect, it } from 'bun:test'
import { db, schema } from '@nuxthub/db'
import { eq } from 'drizzle-orm'
import listHandler from '../server/api/apps/index.get'
import createHandler from '../server/api/apps/index.post'
import updateHandler from '../server/api/apps/[id].put'
import deleteHandler from '../server/api/apps/[id].delete'
import { callAppHook, callAllAppHooks } from '../server/utils/appHooks'
import { baseUrlSchema } from '../server/utils/validation'
import { createServiceToken, hashServiceToken, requireServiceToken } from '../server/utils/serviceToken'
import { syncApp } from '../server/utils/manifestSync'
import { fetchMock, rawFetchMock, makeEvent } from './setup'
import type { FakeEvent } from './setup'
import { createUser, grantRole, enrolTotp, registerApp, defineRole } from './helpers/users'

const listApps = listHandler as unknown as (e: unknown) => Promise<{ apps: { name: string, hasToken: boolean }[] }>
const createApp = createHandler as unknown as (e: unknown) => Promise<{ app: { id: string, name: string } }>
const updateApp = updateHandler as unknown as (e: unknown) => Promise<{ app: { baseUrl: string, hooksEnabled: boolean } }>
const deleteApp = deleteHandler as unknown as (e: unknown) => Promise<{ ok: boolean }>

let adminCounter = 900

async function adminEvent(extra: Partial<FakeEvent> = {}): Promise<FakeEvent> {
  adminCounter += 1
  const admin = await createUser({ email: `appadmin${adminCounter}@example.com`, plainPassword: 'Passw0rd', verified: true })
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
  return event
}

describe('app registry (ADR-0017)', () => {
  it('registers an app and links a token issued before it', async () => {
    await db.insert(schema.serviceTokens).values({ name: 'photos', tokenHash: 'hash-x' })

    const event = await adminEvent({
      body: { name: 'photos', namespace: 'photos', displayName: 'Photos', baseUrl: 'https://photos.newtheatre.org.uk', hooksEnabled: true },
    })
    const { app } = await createApp(event)

    const token = await db.select().from(schema.serviceTokens).where(eq(schema.serviceTokens.name, 'photos')).get()
    expect(token!.appId).toBe(app.id)

    const audit = await db.select().from(schema.auditLog).all()
    expect(audit.map(a => a.action)).toContain('app.registered')
  })

  it('refuses a duplicate name or namespace', async () => {
    await registerApp('rooms')

    const sameName = await adminEvent({
      body: { name: 'rooms', namespace: 'other', displayName: 'Rooms', baseUrl: 'https://x.newtheatre.org.uk', hooksEnabled: false },
    })
    await expect(createApp(sameName)).rejects.toMatchObject({ statusCode: 409 })

    const sameNamespace = await adminEvent({
      body: { name: 'other', namespace: 'rooms', displayName: 'Other', baseUrl: 'https://x.newtheatre.org.uk', hooksEnabled: false },
    })
    await expect(createApp(sameNamespace)).rejects.toMatchObject({ statusCode: 409 })
  })

  it('rejects a base URL that is neither https nor localhost', async () => {
    const event = await adminEvent({
      body: { name: 'evil', namespace: 'evil', displayName: 'Evil', baseUrl: 'http://evil.example.com', hooksEnabled: true },
    })
    await expect(createApp(event)).rejects.toThrow()
  })

  it('flags a registered app with no service token, which cannot be called', async () => {
    await registerApp('rooms')
    await db.insert(schema.serviceTokens).values({ name: 'rooms', tokenHash: 'hash-r' })
    await registerApp('photos')

    const { apps } = await listApps(await adminEvent())
    expect(apps.find(a => a.name === 'rooms')!.hasToken).toBe(true)
    expect(apps.find(a => a.name === 'photos')!.hasToken).toBe(false)
  })

  it('deregisters and revokes the app\'s tokens with it', async () => {
    const app = await registerApp('photos')
    await db.insert(schema.serviceTokens).values({ name: 'photos', tokenHash: 'hash-x', appId: app.id })

    await deleteApp(await adminEvent({ params: { id: app.id } }))

    expect(await db.select().from(schema.apps).all()).toHaveLength(0)
    // Orphaning it would leave a credential that still authenticates inbound.
    expect(await db.select().from(schema.serviceTokens).all()).toHaveLength(0)
  })

  it('withdraws the app\'s role definitions with it, so dead roles stop being grantable', async () => {
    const app = await registerApp('photos', { namespace: 'photos' })
    await defineRole('photos', 'ADMIN')
    await defineRole('photos', 'EDITOR')

    const audited = await adminEvent({ params: { id: app.id } })
    await deleteApp(audited)

    // No foreign key cascades role_definitions, so nothing else would.
    const definitions = await db.select().from(schema.roleDefinitions).all()
    expect(definitions).toHaveLength(2)
    expect(definitions.every(d => d.withdrawnAt !== null)).toBe(true)

    const entry = await db.select().from(schema.auditLog)
      .where(eq(schema.auditLog.action, 'app.deregistered')).get()
    expect(JSON.parse(entry!.detail!).definitionsWithdrawn).toBe(2)
  })

  it('revokes a token issued after registration, which carries no app_id link', async () => {
    // The documented order: register, then issue. app_id is a reporting column
    // and the revoke must not depend on it (ADR-0017).
    const app = await registerApp('photos')
    await createServiceToken('photos')

    const audited = await adminEvent({ params: { id: app.id } })
    await deleteApp(audited)

    expect(await db.select().from(schema.serviceTokens).all()).toHaveLength(0)
    const entry = await db.select().from(schema.auditLog)
      .where(eq(schema.auditLog.action, 'app.deregistered')).get()
    expect(JSON.parse(entry!.detail!).tokensRevoked).toBe(1)
  })

  it('revokes a rotated token whose link was dropped with the row that carried it', async () => {
    const app = await registerApp('photos')
    await db.insert(schema.serviceTokens).values({ name: 'photos', tokenHash: 'hash-old', appId: app.id })
    await db.delete(schema.serviceTokens).where(eq(schema.serviceTokens.tokenHash, 'hash-old'))
    await db.insert(schema.serviceTokens).values({ name: 'photos', tokenHash: 'hash-new' })

    await deleteApp(await adminEvent({ params: { id: app.id } }))

    expect(await db.select().from(schema.serviceTokens).all()).toHaveLength(0)
  })

  it('records the manifest switch on both sides, so turning it off is recoverable', async () => {
    // Nothing else records it: ADR-0024 leaves no other way for an app's new
    // roles to appear, so the flip has to be traceable to a person.
    const created = await adminEvent({
      body: { name: 'photos', namespace: 'photos', displayName: 'Photos', baseUrl: 'https://photos.newtheatre.org.uk', hooksEnabled: true, manifestEnabled: true },
    })
    const { app } = await createApp(created)

    const registered = await db.select().from(schema.auditLog)
      .where(eq(schema.auditLog.action, 'app.registered')).get()
    expect(JSON.parse(registered!.detail!).manifestEnabled).toBe(true)

    await updateApp(await adminEvent({
      params: { id: app.id },
      body: { displayName: 'Photos', baseUrl: 'https://photos.newtheatre.org.uk', hooksEnabled: true, manifestEnabled: false },
    }))

    const updated = await db.select().from(schema.auditLog)
      .where(eq(schema.auditLog.action, 'app.updated')).get()
    const detail = JSON.parse(updated!.detail!)
    expect(detail.from.manifestEnabled).toBe(true)
    expect(detail.to.manifestEnabled).toBe(false)
  })

  it('refuses an update that omits the manifest switch rather than defaulting it off', async () => {
    // The update is a full replace, so a default would silently stop role sync.
    const app = await registerApp('photos', { manifestEnabled: true })

    await expect(updateApp(await adminEvent({
      params: { id: app.id },
      body: { displayName: 'Photos', baseUrl: 'https://photos.newtheatre.org.uk', hooksEnabled: true },
    }))).rejects.toThrow()

    const row = await db.select().from(schema.apps).where(eq(schema.apps.id, app.id)).get()
    expect(row!.manifestEnabled).toBe(true)
  })

  it('leaves an unlinked token alone when a different app is deregistered', async () => {
    const app = await registerApp('photos')
    await db.insert(schema.serviceTokens).values({ name: 'rooms', tokenHash: 'hash-r' })

    await deleteApp(await adminEvent({ params: { id: app.id } }))

    const left = await db.select().from(schema.serviceTokens).all()
    expect(left.map(t => t.name)).toEqual(['rooms'])
  })
})

describe('hooks fan out from the registry, not a hardcoded list', () => {
  it('calls every app with hooks enabled and skips the rest', async () => {
    await registerApp('proscenium', { baseUrl: 'https://newtheatre.org.uk' })
    await registerApp('rooms')
    await registerApp('rehearsal', { namespace: 'training', baseUrl: 'https://training.newtheatre.org.uk' })
    await registerApp('photos', { hooksEnabled: false })
    await db.insert(schema.serviceTokens).values([
      { name: 'proscenium', tokenHash: 'hash-p' },
      { name: 'rooms', tokenHash: 'hash-r' },
      { name: 'rehearsal', tokenHash: 'hash-t' },
      { name: 'photos', tokenHash: 'hash-x' },
    ])
    fetchMock.mockResolvedValue({ ok: true })

    const results = await callAllAppHooks<{ ok: boolean }>('anonymise', { userId: 'u1' })

    expect(results.map(r => r.app).sort()).toEqual(['proscenium', 'rehearsal', 'rooms'])
    const urls = fetchMock.mock.calls.map(c => c[0])
    // The training app was unreachable before the registry existed.
    expect(urls).toContain('https://training.newtheatre.org.uk/api/_hooks/auth/anonymise')
    expect(urls).not.toContain('https://photos.newtheatre.org.uk/api/_hooks/auth/anonymise')
  })

  it('reports an unregistered app as a failed hook rather than throwing', async () => {
    const result = await callAppHook('nowhere', 'export', { userId: 'u1' })

    expect(result).toMatchObject({ app: 'nowhere', ok: false })
    expect(result.error).toContain('not registered')
  })

  it('picks up a base URL change with no deploy', async () => {
    const app = await registerApp('rooms', { baseUrl: 'https://old.newtheatre.org.uk' })
    await db.insert(schema.serviceTokens).values({ name: 'rooms', tokenHash: 'hash-r' })
    fetchMock.mockResolvedValue({ ok: true })

    await updateApp(await adminEvent({
      params: { id: app.id },
      body: { displayName: 'Rooms', baseUrl: 'https://rooms.newtheatre.org.uk', hooksEnabled: true, manifestEnabled: false },
    }))
    await callAllAppHooks('anonymise', { userId: 'u1' })

    expect(fetchMock.mock.calls.map(c => c[0]))
      .toEqual(['https://rooms.newtheatre.org.uk/api/_hooks/auth/anonymise'])
  })
})

describe('the base URL localhost escape hatch', () => {
  it.each([
    'http://localhost.attacker.example/x',
    'http://localhostile.example',
    'http://localhost@evil.example/',
    'http://evil.example/localhost',
  ])('rejects %s', (baseUrl) => {
    expect(baseUrlSchema.safeParse(baseUrl).success).toBe(false)
  })

  it('rejects plain http://localhost outside development', () => {
    // import.meta.dev is undefined under vitest, so this is the prod branch.
    expect(baseUrlSchema.safeParse('http://localhost:3001').success).toBe(false)
  })

  it('still accepts https origins', () => {
    expect(baseUrlSchema.safeParse('https://rooms.newtheatre.org.uk').success).toBe(true)
  })
})

describe('overlap token rotation (docs/operations.md)', () => {
  it('issues a second token for the same app without a unique clash', async () => {
    const first = await createServiceToken('proscenium')
    const second = await createServiceToken('proscenium')

    expect(first.id).not.toBe(second.id)
    const rows = await db.select().from(schema.serviceTokens).all()
    expect(rows).toHaveLength(2)
  })

  it('authenticates on either token, and sends the newest outbound', async () => {
    await registerApp('proscenium', { baseUrl: 'https://newtheatre.org.uk' })
    const old = await createServiceToken('proscenium')
    // createdAt is the tiebreak, so the new row must sort after the old one.
    await db.update(schema.serviceTokens)
      .set({ createdAt: new Date(Date.now() - 60_000) })
      .where(eq(schema.serviceTokens.id, old.id))
    const fresh = await createServiceToken('proscenium')

    // Both are accepted inbound during the overlap.
    for (const token of [old.token, fresh.token]) {
      const event = makeEvent({ headers: { authorization: `Bearer ${token}` } })
      await expect(requireServiceToken(event)).resolves.toMatchObject({ name: 'proscenium' })
    }

    // Outbound uses the newest, so the app can revoke the old one safely.
    fetchMock.mockResolvedValue({ ok: true })
    await callAppHook('proscenium', 'anonymise', { userId: 'u1' })
    const [, options] = fetchMock.mock.calls.at(-1)!
    expect(options.headers.Authorization).toBe(`Bearer ${hashServiceToken(fresh.token)}`)
  })

  it('sends the newest on the manifest fetch too, so a rotation cannot break sync', async () => {
    const app = await registerApp('rooms', { manifestEnabled: true })
    const old = await createServiceToken('rooms')
    await db.update(schema.serviceTokens)
      .set({ createdAt: new Date(Date.now() - 60_000) })
      .where(eq(schema.serviceTokens.id, old.id))
    const fresh = await createServiceToken('rooms')

    rawFetchMock.mockResolvedValue({
      status: 500,
      _data: '',
      headers: { get: () => null },
    })
    await syncApp(app)

    const [, options] = rawFetchMock.mock.calls.at(-1)!
    expect(options.headers.Authorization).toBe(`Bearer ${hashServiceToken(fresh.token)}`)
  })
})
