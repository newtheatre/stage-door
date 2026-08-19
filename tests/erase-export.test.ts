import { describe, expect, it } from 'vitest'
import { db, schema } from '@nuxthub/db'
import { eq } from 'drizzle-orm'
import { eraseUser } from '../server/utils/erase'
import { exportUser } from '../server/utils/exportUser'
import { fetchMock } from './setup'
import { createUser, grantRole, enrolTotp, registerApp } from './helpers/users'
import { regenerateRecoveryCodes } from '../server/utils/mfa'

function hooksSucceed() {
  fetchMock.mockResolvedValue({ ok: true })
}

describe('eraseUser — anonymise, never delete (ADR-0008)', () => {
  it('rewrites identity, strips credentials/roles/tokens, bumps epoch, calls every hook', async () => {
    // A registry row plus a service token per app so hook bearers resolve.
    await registerApp('proscenium', { baseUrl: 'https://newtheatre.org.uk' })
    await registerApp('rooms')
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
    await enrolTotp(user.id)
    await regenerateRecoveryCodes(user.id)

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
    // Second factors are credentials too (ADR-0012).
    expect(await db.select().from(schema.totpSecrets).all()).toHaveLength(0)
    expect(await db.select().from(schema.mfaRecoveryCodes).all()).toHaveLength(0)

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
    await registerApp('proscenium', { baseUrl: 'https://newtheatre.org.uk' })
    await registerApp('rooms')
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
    await registerApp('proscenium', { baseUrl: 'https://newtheatre.org.uk' })
    await registerApp('rooms')
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
    // Factor types and dates belong in a SAR; secrets and public keys don't.
    expect(bundle.account.mfa).toMatchObject({ totp: null, passkeys: [], recoveryCodesRemaining: 0 })
    expect(JSON.stringify(bundle.account.mfa)).not.toContain('JBSWY3DPEHPK3PXP')
    expect(bundle.apps.rooms).toEqual({ bookings: [1, 2] })
    expect(bundle.apps.proscenium).toEqual({ reservations: [3] })
  })

  it('surfaces a hook failure without sinking the export', async () => {
    await registerApp('proscenium', { baseUrl: 'https://newtheatre.org.uk' })
    await registerApp('rooms')
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

describe('the subject-access bundle does not carry other people\'s data', () => {
  it('strips detail from rows the subject only acted on', async () => {
    const admin = await createUser({ email: 'admin-x@example.com', name: 'Admin' })
    const other = await createUser({ email: 'victim@example.com', name: 'Victim' })

    // An admin editing someone else's email: actor = admin, target = other.
    await writeAudit({
      actorUserId: admin.id,
      action: 'user.updated',
      target: other.id,
      detail: { email: { from: 'old@example.com', to: 'new@example.com' } },
    })
    // Something done to the admin themselves keeps its detail.
    await writeAudit({
      actorUserId: other.id,
      action: 'user.force-logout',
      target: admin.id,
      detail: { reason: 'test' },
    })

    const bundle = await exportUser(admin.id) as { auditEntries: { action: string, detail: unknown }[] }

    const acted = bundle.auditEntries.find(e => e.action === 'user.updated')
    expect(acted).toBeTruthy()
    expect(acted!.detail).toBeNull() // the other person's addresses are gone

    const targeted = bundle.auditEntries.find(e => e.action === 'user.force-logout')
    expect(targeted!.detail).not.toBeNull()

    expect(JSON.stringify(bundle)).not.toContain('old@example.com')
  })
})

describe('erasure reports completeness honestly', () => {
  it('is not complete when no app was told', async () => {
    // No registry rows, so loadHookApps returns [] and every() is vacuous.
    hooksSucceed()
    const user = await createUser({ email: 'nobody-told@example-user.co.uk' })

    const result = await eraseUser(user.id, { id: 'admin-1', via: 'admin' })

    expect(result.complete).toBe(false)
    const audit = await db.select().from(schema.auditLog)
      .where(eq(schema.auditLog.target, user.id)).all()
    expect(audit[0]?.action).toBe('user.erase-incomplete')
  })

  it('is not complete when an app answers 200 with { ok: false }', async () => {
    await registerApp('rooms')
    await db.insert(schema.serviceTokens).values({ name: 'rooms', tokenHash: 'hash-r' })
    fetchMock.mockResolvedValue({ ok: false })

    const user = await createUser({ email: 'refused@example-user.co.uk' })
    const result = await eraseUser(user.id, { id: 'admin-1', via: 'admin' })

    expect(result.complete).toBe(false)
  })

  it('never returns an upstream error message to the caller', async () => {
    await registerApp('rooms')
    await db.insert(schema.serviceTokens).values({ name: 'rooms', tokenHash: 'hash-r' })
    fetchMock.mockRejectedValue(new Error('[POST] "https://rooms.newtheatre.org.uk/api/_hooks/auth/anonymise": 500 Internal Server Error'))

    const user = await createUser({ email: 'leaky@example-user.co.uk' })
    const result = await eraseUser(user.id, { id: 'admin-1', via: 'admin' })

    expect(result.complete).toBe(false)
    expect(result.hooks).toEqual([{ app: 'rooms', ok: false }])
    expect(JSON.stringify(result)).not.toContain('rooms.newtheatre.org.uk')
    expect(JSON.stringify(result)).not.toContain('500')
  })
})

describe('erasure clears the side tables keyed to the user', () => {
  it('removes eligibility snapshots and retention notices', async () => {
    hooksSucceed()
    const user = await createUser({ email: 'sideways@example-user.co.uk' })

    await db.insert(schema.eligibilitySnapshots).values({
      ruleKey: 'duty-manager',
      userId: user.id,
      capturedAt: new Date(),
    })
    await db.insert(schema.retentionNotices).values({ userId: user.id, stage: 'warning-60d' })

    await eraseUser(user.id, { id: 'admin-1', via: 'admin' })

    const snaps = await db.select().from(schema.eligibilitySnapshots)
      .where(eq(schema.eligibilitySnapshots.userId, user.id)).all()
    expect(snaps).toHaveLength(0)

    const notices = await db.select().from(schema.retentionNotices)
      .where(eq(schema.retentionNotices.userId, user.id)).all()
    expect(notices).toHaveLength(0)
  })
})
