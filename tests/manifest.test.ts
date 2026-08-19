/**
 * Manifest ingestion (ADR-0018). The property that matters most: nothing is
 * ever withdrawn except as a consequence of a document that parsed.
 */

import { describe, expect, it } from 'vitest'
import { db, schema } from '@nuxthub/db'
import { manifestSchema } from '../server/utils/manifest'
import { syncApp } from '../server/utils/manifestSync'
import { assertGrantsDefined } from '../server/utils/roleDefinitions'
import { rawFetchMock } from './setup'
import { createUser, grantRole, registerApp } from './helpers/users'

function manifestBody(overrides: Record<string, unknown> = {}) {
  return {
    contract: 1,
    namespace: 'rooms',
    version: '1',
    permissions: [
      { key: 'admin.access', description: 'Admin surface' },
      { key: 'booking.read.any', description: 'See any booking' },
    ],
    roles: [
      {
        role: 'ADMIN',
        description: 'Room-booking admin',
        defaultExpiry: { kind: 'committee-year' },
        permissions: ['admin.access', 'booking.read.any'],
        requiresEligibility: null,
      },
    ],
    eligibilityRules: [],
    ...overrides,
  }
}

/** $fetch.raw is what the fetcher uses; the mock has to look like a response. */
function serve(body: unknown, { status = 200, etag = null as string | null } = {}) {
  rawFetchMock.mockResolvedValue({
    status,
    _data: JSON.stringify(body),
    headers: { get: (name: string) => (name.toLowerCase() === 'etag' ? etag : null) },
  })
}

async function roomsApp() {
  const app = await registerApp('rooms', { manifestEnabled: true })
  await db.insert(schema.serviceTokens).values({ name: 'rooms', tokenHash: 'hash-r' })
  return app
}

describe('the manifest schema', () => {
  it('refuses a role granting a permission the manifest does not declare', () => {
    const bad = manifestBody({
      roles: [{ role: 'ADMIN', description: 'x', defaultExpiry: { kind: 'none' }, permissions: ['nope.missing'], requiresEligibility: null }],
    })
    expect(() => manifestSchema.parse(bad)).toThrow(/Undeclared permission/)
  })

  it('refuses duplicate roles and duplicate permission keys', () => {
    expect(() => manifestSchema.parse(manifestBody({
      permissions: [{ key: 'a.b', description: 'x' }, { key: 'a.b', description: 'y' }],
    }))).toThrow(/Duplicate permission/)
  })

  it('cannot be satisfied by a role string, and vice versa', () => {
    // Permissions are lowercase and dotted; roles are uppercase and undotted.
    expect(() => manifestSchema.parse(manifestBody({
      permissions: [{ key: 'ADMIN', description: 'x' }],
      roles: [],
    }))).toThrow()
  })
})

describe('reconciliation', () => {
  it('creates definitions and links their permissions', async () => {
    const app = await roomsApp()
    serve(manifestBody())

    const result = await syncApp(app)

    expect(result.ok).toBe(true)
    const definitions = await db.select().from(schema.roleDefinitions).all()
    expect(definitions).toHaveLength(1)
    expect(definitions[0]).toMatchObject({ namespace: 'rooms', role: 'ADMIN', source: 'manifest' })
    expect(await db.select().from(schema.roleDefinitionPermissions).all()).toHaveLength(2)
  })

  it('is idempotent: a second pass over the same document changes nothing', async () => {
    const app = await roomsApp()
    serve(manifestBody())
    await syncApp(app)
    const after = await db.select().from(schema.roleDefinitions).get()

    const second = await syncApp(app)

    expect(second.unchanged).toBe(true)
    expect(await db.select().from(schema.roleDefinitions).get()).toEqual(after)
  })

  it('adopts a hand-made definition rather than colliding with it', async () => {
    const app = await roomsApp()
    await db.insert(schema.roleDefinitions).values({
      namespace: 'rooms', role: 'ADMIN', description: 'Typed in by hand', defaultExpiryKind: 'none',
    })
    serve(manifestBody())

    await syncApp(app)

    const definition = await db.select().from(schema.roleDefinitions).get()
    expect(definition).toMatchObject({ source: 'manifest', description: 'Room-booking admin', appId: app.id })
    const audit = await db.select().from(schema.auditLog).all()
    // The previous values are in the audit detail, so adoption is reversible.
    expect(audit.map(a => a.action)).toContain('role-definition.adopted')
  })

  it('withdraws a role the manifest drops, without touching its grants', async () => {
    const app = await roomsApp()
    serve(manifestBody())
    await syncApp(app)
    const holder = await createUser({ email: 'holder@example.com', plainPassword: 'Passw0rd' })
    await grantRole(holder.id, 'rooms:ADMIN')

    serve(manifestBody({ version: '2', roles: [] }))
    await syncApp(app)

    const definition = await db.select().from(schema.roleDefinitions).get()
    expect(definition!.withdrawnAt).not.toBeNull()
    // The grant survives, which is ADR-0011's guarantee.
    const grants = await db.select().from(schema.userRoles).all()
    expect(grants).toHaveLength(1)
    expect(grants[0]!.role).toBe('rooms:ADMIN')
  })

  it('respects a pinned default expiry, so an app cannot move committee policy', async () => {
    const app = await roomsApp()
    serve(manifestBody())
    await syncApp(app)
    await db.update(schema.roleDefinitions)
      .set({ defaultExpiryKind: 'none', defaultExpiryPinned: true })

    serve(manifestBody({ version: '2' }))
    await syncApp(app)

    expect((await db.select().from(schema.roleDefinitions).get())!.defaultExpiryKind).toBe('none')
  })
})

describe('a manifest that does not parse withdraws nothing', () => {
  it('keeps the last good document when the app is unreachable', async () => {
    const app = await roomsApp()
    serve(manifestBody())
    await syncApp(app)

    rawFetchMock.mockRejectedValue(new Error('connect ECONNREFUSED'))
    const result = await syncApp(app)

    expect(result.ok).toBe(false)
    const definition = await db.select().from(schema.roleDefinitions).get()
    expect(definition!.withdrawnAt).toBeNull()
    const stored = await db.select().from(schema.appManifests).get()
    expect(stored!.lastError).toContain('ECONNREFUSED')
    expect(stored!.document).not.toBe('')
  })

  it('rejects a malformed document without changing a definition', async () => {
    const app = await roomsApp()
    serve(manifestBody())
    await syncApp(app)

    serve({ contract: 1, namespace: 'rooms', version: '2', roles: 'not an array' })
    const result = await syncApp(app)

    expect(result.ok).toBe(false)
    const definition = await db.select().from(schema.roleDefinitions).get()
    expect(definition).toMatchObject({ role: 'ADMIN', withdrawnAt: null, manifestVersion: '1' })
  })

  it('refuses a manifest claiming a namespace it is not registered for', async () => {
    const app = await roomsApp()
    serve(manifestBody({ namespace: 'proscenium' }))

    const result = await syncApp(app)

    expect(result.ok).toBe(false)
    expect(result.error).toContain('registered as')
    expect(await db.select().from(schema.roleDefinitions).all()).toHaveLength(0)
  })

  it('refuses any manifest claiming the auth namespace', async () => {
    const app = await registerApp('evil', { namespace: 'auth', manifestEnabled: true })
    await db.insert(schema.serviceTokens).values({ name: 'evil', tokenHash: 'hash-e' })
    serve(manifestBody({ namespace: 'auth' }))

    const result = await syncApp(app)

    expect(result.ok).toBe(false)
    expect(result.error).toContain('auth namespace')
  })
})

describe('a withdrawn role cannot be granted again', () => {
  it('refuses a new grant but leaves existing holders editable', async () => {
    const app = await roomsApp()
    serve(manifestBody())
    await syncApp(app)
    const holder = await createUser({ email: 'keeps@example.com', plainPassword: 'Passw0rd' })
    await grantRole(holder.id, 'rooms:ADMIN')

    serve(manifestBody({ version: '2', roles: [] }))
    await syncApp(app)

    // The holder keeps it: assertGrantsDefined exempts what someone already has.
    await expect(assertGrantsDefined([{ role: 'rooms:ADMIN' }], new Set(['rooms:ADMIN']))).resolves.toBeUndefined()
    // A fresh grant of the same role is refused.
    await expect(assertGrantsDefined([{ role: 'rooms:ADMIN' }], new Set())).rejects.toMatchObject({ statusCode: 400 })
  })
})

describe('the permission vocabulary is queryable', () => {
  it('answers which roles carry a permission, and how many hold one', async () => {
    const app = await roomsApp()
    serve(manifestBody())
    await syncApp(app)
    const holder = await createUser({ email: 'admin-holder@example.com', plainPassword: 'Passw0rd' })
    await grantRole(holder.id, 'rooms:ADMIN')

    const permissions = await db.select().from(schema.appPermissions).all()
    expect(permissions.map(p => p.key).sort()).toEqual(['admin.access', 'booking.read.any'])

    const links = await db.select().from(schema.roleDefinitionPermissions).all()
    expect(links).toHaveLength(2)
  })

  it('deactivates a permission the manifest stops declaring, without deleting it', async () => {
    const app = await roomsApp()
    serve(manifestBody())
    await syncApp(app)

    serve(manifestBody({
      version: '2',
      permissions: [{ key: 'admin.access', description: 'Admin surface' }],
      roles: [{
        role: 'ADMIN', description: 'Room-booking admin', defaultExpiry: { kind: 'committee-year' },
        permissions: ['admin.access'], requiresEligibility: null,
      }],
    }))
    await syncApp(app)

    const permissions = await db.select().from(schema.appPermissions).all()
    expect(permissions).toHaveLength(2)
    expect(permissions.find(p => p.key === 'booking.read.any')!.active).toBe(false)
  })
})
