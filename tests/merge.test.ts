import { describe, expect, it } from 'bun:test'
import { db, schema } from '@nuxthub/db'
import { eq } from 'drizzle-orm'
import mergeHandler from '../server/api/users/[id]/merge.post'
import { mergeUsers } from '../server/utils/mergeUsers'
import type { MergeResult } from '../server/utils/mergeUsers'
import { fetchMock, makeEvent, type FakeEvent } from './setup'
import { createUser, grantRole, enrolTotp, registerApp } from './helpers/users'

const merge = mergeHandler as unknown as (event: unknown) => Promise<MergeResult>

const DAY = 24 * 60 * 60 * 1000

async function seedTokens() {
  await registerApp('proscenium', { baseUrl: 'https://newtheatre.org.uk' })
  await registerApp('rooms')
  await db.insert(schema.serviceTokens).values([
    { name: 'proscenium', tokenHash: 'hash-p' },
    { name: 'rooms', tokenHash: 'hash-r' },
  ])
}

function hooksSucceed() {
  fetchMock.mockResolvedValue({ ok: true, notMirrored: false, counts: { reservations: 2 } })
}

let adminCounter = 500

async function adminEvent(extra: Partial<FakeEvent> = {}) {
  adminCounter += 1
  const admin = await createUser({ email: `merge-admin${adminCounter}@example-user.co.uk`, plainPassword: 'Passw0rd', verified: true })
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

async function caught(fn: () => Promise<unknown>) {
  try {
    await fn()
    return undefined
  }
  catch (error) {
    return error as { statusCode: number, statusMessage: string }
  }
}

describe('mergeUsers: dry run', () => {
  it('calls every hook with dryRun and writes nothing', async () => {
    await seedTokens()
    hooksSucceed()
    const winner = await createUser({ email: 'winner@example-user.co.uk', plainPassword: 'Passw0rd' })
    const loser = await createUser({ email: 'loser@example-user.co.uk' })
    await grantRole(loser.id, 'proscenium:BOX_OFFICE')

    const result = await mergeUsers(winner.id, loser.id, { id: 'admin-1' }, { dryRun: true })

    expect(result.dryRun).toBe(true)
    expect(result.complete).toBe(true)
    expect(result.plan.roles).toEqual([
      { role: 'proscenium:BOX_OFFICE', outcome: 'moved', expiresAt: null },
    ])

    // Both hooks called with dryRun: true.
    expect(fetchMock).toHaveBeenCalledTimes(2)
    for (const call of fetchMock.mock.calls) {
      expect(call[1].body).toMatchObject({ fromUserId: loser.id, toUserId: winner.id, dryRun: true })
    }

    // Nothing changed: loser intact, winner gained nothing.
    const loserAfter = await db.select().from(schema.users).where(eq(schema.users.id, loser.id)).get()
    expect(loserAfter?.email).toBe('loser@example-user.co.uk')
    expect(await db.select().from(schema.userRoles).where(eq(schema.userRoles.userId, winner.id)).all()).toHaveLength(0)
  })
})

describe('mergeUsers: commit', () => {
  it('unions roles, moves legacy ids, fills credentials, erases the loser', async () => {
    await seedTokens()
    hooksSucceed()

    // Winner: shadow account (no credentials), permanent BOX_OFFICE.
    const winner = await createUser({ email: 'shadow-winner@example-user.co.uk', verified: false })
    await grantRole(winner.id, 'proscenium:BOX_OFFICE')

    // Loser: password + verified, an earlier-expiring BOX_OFFICE (conflict),
    // a definition-less legacy role, and a legacy id.
    const loser = await createUser({ email: 'full-loser@example-user.co.uk', plainPassword: 'Passw0rd', verified: true })
    const loserExpiry = new Date(Date.now() + 30 * DAY)
    await grantRole(loser.id, 'proscenium:BOX_OFFICE', { expiresAt: loserExpiry, grantedBy: 'someone' })
    await grantRole(loser.id, 'ticketing:LEGACY', { note: 'from the import' })
    await db.insert(schema.legacyIds).values({ userId: loser.id, source: 'proscenium', legacyId: 'old-123' })

    const result = await mergeUsers(winner.id, loser.id, { id: 'admin-1' }, { dryRun: false })

    expect(result.complete).toBe(true)

    // Role union: conflict took the earliest expiry (date beats permanent);
    // the legacy role moved with its provenance despite having no definition.
    const winnerGrants = await db.select().from(schema.userRoles)
      .where(eq(schema.userRoles.userId, winner.id)).all()
    const boxOffice = winnerGrants.find(g => g.role === 'proscenium:BOX_OFFICE')
    expect(boxOffice?.expiresAt?.getTime()).toBe(loserExpiry.getTime())
    const legacy = winnerGrants.find(g => g.role === 'ticketing:LEGACY')
    expect(legacy?.note).toBe('from the import')

    // Legacy ids moved, plus the merge marker.
    const ids = await db.select().from(schema.legacyIds)
      .where(eq(schema.legacyIds.userId, winner.id)).all()
    expect(ids.map(i => `${i.source}:${i.legacyId}`).sort())
      .toEqual([`merge:${loser.id}`, 'proscenium:old-123'].sort())

    // Credentials filled: the shadow winner gained the loser's password and
    // verified flag; epoch bumped.
    const winnerAfter = await db.select().from(schema.users).where(eq(schema.users.id, winner.id)).get()
    expect(winnerAfter?.password).toBe('fake$Passw0rd')
    expect(winnerAfter?.verified).toBe(true)
    expect(winnerAfter?.sessionEpoch).toBe(1)

    // Loser erased: anonymised, disabled, no roles left.
    const loserAfter = await db.select().from(schema.users).where(eq(schema.users.id, loser.id)).get()
    expect(loserAfter?.email).toBe(`deleted-${loser.id}@anonymised.invalid`)
    expect(loserAfter?.disabled).toBe(true)
    expect(await db.select().from(schema.userRoles).where(eq(schema.userRoles.userId, loser.id)).all()).toHaveLength(0)

    // Audited with both ids, no personal data.
    const audit = await db.select().from(schema.auditLog)
      .where(eq(schema.auditLog.action, 'user.merged')).all()
    expect(audit).toHaveLength(1)
    expect(audit[0]?.target).toBe(winner.id)
    expect(audit[0]?.detail).toContain(loser.id)
    expect(audit[0]?.detail).not.toContain('full-loser@')
  })

  it('never overwrites credentials the winner already has', async () => {
    await seedTokens()
    hooksSucceed()
    const winner = await createUser({ email: 'keeps@example-user.co.uk', plainPassword: 'WinnerPw1', googleSub: 'g-winner' })
    const loser = await createUser({ email: 'loses@example-user.co.uk', plainPassword: 'LoserPw1', googleSub: 'g-loser' })

    await mergeUsers(winner.id, loser.id, { id: 'admin-1' }, { dryRun: false })

    const after = await db.select().from(schema.users).where(eq(schema.users.id, winner.id)).get()
    expect(after?.password).toBe('fake$WinnerPw1')
    expect(after?.googleSub).toBe('g-winner')
  })

  it('moves the loser google link onto a google-less winner (unique freed by erasure)', async () => {
    await seedTokens()
    hooksSucceed()
    const winner = await createUser({ email: 'no-google@example-user.co.uk', plainPassword: 'Passw0rd' })
    const loser = await createUser({ email: 'has-google@example-user.co.uk', googleSub: 'g-only' })

    await mergeUsers(winner.id, loser.id, { id: 'admin-1' }, { dryRun: false })

    const after = await db.select().from(schema.users).where(eq(schema.users.id, winner.id)).get()
    expect(after?.googleSub).toBe('g-only')
  })

  it('stops before any central change when a hook fails, and a re-run completes', async () => {
    await seedTokens()
    fetchMock.mockImplementation((url: string) =>
      url.includes('rooms') ? Promise.reject(new Error('rooms down')) : Promise.resolve({ ok: true }))

    const winner = await createUser({ email: 'patient-winner@example-user.co.uk', plainPassword: 'Passw0rd' })
    const loser = await createUser({ email: 'patient-loser@example-user.co.uk' })
    await grantRole(loser.id, 'rooms:BOOKER')

    const first = await mergeUsers(winner.id, loser.id, { id: 'admin-1' }, { dryRun: false })

    expect(first.complete).toBe(false)
    // Nothing moved, nobody erased.
    expect(await db.select().from(schema.userRoles).where(eq(schema.userRoles.userId, winner.id)).all()).toHaveLength(0)
    const loserIntact = await db.select().from(schema.users).where(eq(schema.users.id, loser.id)).get()
    expect(loserIntact?.email).toBe('patient-loser@example-user.co.uk')

    // App recovers; the re-run finishes the job.
    hooksSucceed()
    const second = await mergeUsers(winner.id, loser.id, { id: 'admin-1' }, { dryRun: false })
    expect(second.complete).toBe(true)
    expect((await db.select().from(schema.userRoles).where(eq(schema.userRoles.userId, winner.id)).all())
      .map(g => g.role)).toEqual(['rooms:BOOKER'])
    const loserGone = await db.select().from(schema.users).where(eq(schema.users.id, loser.id)).get()
    expect(loserGone?.email).toBe(`deleted-${loser.id}@anonymised.invalid`)
  })

  it('deletes the loser retention notices rather than colliding', async () => {
    await seedTokens()
    hooksSucceed()
    const winner = await createUser({ email: 'noticed-w@example-user.co.uk' })
    const loser = await createUser({ email: 'noticed-l@example-user.co.uk' })
    await db.insert(schema.retentionNotices).values([
      { userId: winner.id, stage: 'warning-60d', sentAt: new Date() },
      { userId: loser.id, stage: 'warning-60d', sentAt: new Date() },
    ])

    const result = await mergeUsers(winner.id, loser.id, { id: 'admin-1' }, { dryRun: false })
    expect(result.complete).toBe(true)

    const notices = await db.select().from(schema.retentionNotices).all()
    expect(notices).toHaveLength(1)
    expect(notices[0]?.userId).toBe(winner.id)
  })

  it('refuses self-merge, merging yourself away, and anonymised accounts', async () => {
    await seedTokens()
    hooksSucceed()
    const user = await createUser({ email: 'solo@example-user.co.uk' })
    const other = await createUser({ email: 'other@example-user.co.uk' })
    const ghost = await createUser({ email: `deleted-x@anonymised.invalid` })

    expect((await caught(() => mergeUsers(user.id, user.id, { id: 'a' }, { dryRun: true })))?.statusCode).toBe(400)
    expect((await caught(() => mergeUsers(other.id, user.id, { id: user.id }, { dryRun: true })))?.statusCode).toBe(400)
    expect((await caught(() => mergeUsers(user.id, ghost.id, { id: 'a' }, { dryRun: true })))?.statusCode).toBe(400)
    expect((await caught(() => mergeUsers(ghost.id, user.id, { id: 'a' }, { dryRun: true })))?.statusCode).toBe(400)
  })
})

describe('POST /api/users/:id/merge', () => {
  it('requires the loser email as typed confirmation for a commit, but not a dry run', async () => {
    await seedTokens()
    hooksSucceed()
    const winner = await createUser({ email: 'endpoint-w@example-user.co.uk' })
    const loser = await createUser({ email: 'endpoint-l@example-user.co.uk' })

    const dry = await adminEvent({ params: { id: winner.id }, body: { loserId: loser.id, dryRun: true } })
    expect((await merge(dry.event)).dryRun).toBe(true)

    const wrong = await adminEvent({ params: { id: winner.id }, body: { loserId: loser.id, confirmEmail: 'nope@example.com' } })
    expect((await caught(() => merge(wrong.event)))?.statusCode).toBe(400)

    const right = await adminEvent({ params: { id: winner.id }, body: { loserId: loser.id, confirmEmail: 'ENDPOINT-L@example-user.co.uk' } })
    const result = await merge(right.event)
    expect(result.complete).toBe(true)
  })
})
