import { afterEach, describe, expect, it } from 'bun:test'
import { db, schema } from '@nuxthub/db'
import { eq } from 'drizzle-orm'
import sweepTask from '../server/tasks/retention/sweep'
import { eraseUser } from '../server/utils/erase'
import { RETENTION_CONFIG } from '../server/utils/retentionConfig'
import { fetchMock, failWarningsTo, sentEmails } from './setup'
import { createUser, registerApp } from './helpers/users'

const sweep = sweepTask as unknown as { run: () => Promise<{ result: Record<string, number | boolean> }> }

// The config is a module singleton the task reads through the auto-import.
const config = RETENTION_CONFIG as unknown as { dryRun: boolean }

afterEach(() => {
  config.dryRun = true
})

const DAY = 24 * 60 * 60 * 1000

/** A guest (shadow) account old enough for the three-year guest clock. */
async function ancientGuest(email: string) {
  const ancient = new Date(Date.now() - 4 * 365 * DAY)
  return createUser({ email, createdAt: ancient })
}

/** A full account already warned and reminded, so this run anonymises it. */
async function longDormant(email: string) {
  const ancient = new Date(Date.now() - 5 * 365 * DAY)
  const user = await createUser({ email, plainPassword: 'Passw0rd', verified: true, lastLogin: ancient, createdAt: ancient })
  await db.insert(schema.retentionNotices).values([
    { userId: user.id, stage: 'warning-60d', sentAt: new Date(Date.now() - 61 * DAY) },
    { userId: user.id, stage: 'warning-30d', sentAt: new Date(Date.now() - 31 * DAY) },
  ])
  return user
}

describe('retention sweep: a failed erasure is not silently lost', () => {
  it('reports incomplete erasures and re-drives them on the next run', async () => {
    await registerApp('rooms')
    await db.insert(schema.serviceTokens).values({ name: 'rooms', tokenHash: 'hash-r' })

    const user = await longDormant('dormant@example-user.co.uk')
    config.dryRun = false

    // The app is down, so the anonymise hook fails.
    fetchMock.mockRejectedValue(new Error('rooms is down'))
    const first = await sweep.run()

    expect(first.result.anonymiseFull).toBe(1)
    expect(first.result.incompleteErasures).toBe(1)

    // Locally anonymised, so planRetention will never select it again.
    const row = await db.select().from(schema.users).where(eq(schema.users.id, user.id)).get()
    expect(row!.email).toBe(`deleted-${user.id}@anonymised.invalid`)

    // Next run: the app is back. Nothing is planned, but the stalled erasure
    // is re-driven off the audit trail.
    fetchMock.mockResolvedValue({ ok: true })
    const second = await sweep.run()

    expect(second.result.anonymiseFull).toBe(0)
    expect(second.result.incompleteErasures).toBe(0)

    const audit = await db.select().from(schema.auditLog)
      .where(eq(schema.auditLog.target, user.id)).all()
    expect(audit.some(a => a.action === 'user.erased')).toBe(true)
  })

  it('leaves nothing to re-drive once every hook has succeeded', async () => {
    await registerApp('rooms')
    await db.insert(schema.serviceTokens).values({ name: 'rooms', tokenHash: 'hash-r' })

    await longDormant('clean@example-user.co.uk')
    config.dryRun = false
    fetchMock.mockResolvedValue({ ok: true })

    const first = await sweep.run()
    expect(first.result.anonymiseFull).toBe(1)
    expect(first.result.incompleteErasures).toBe(0)

    const second = await sweep.run()
    expect(second.result.incompleteErasures).toBe(0)
  })
})

// bun:sqlite allows far more bound parameters than D1, so this cannot reproduce D1's
// cap of 100. It pins the behaviour; the chunking is what enforces the limit.
describe('retention sweep: D1 bound-parameter cap', () => {
  it('clears more than 100 notices without one oversized statement', async () => {
    config.dryRun = false
    fetchMock.mockResolvedValue({ ok: true })

    // 150 users who were warned and have since logged in: planRetention puts
    // every one of them in clearNotices, which maxActionsPerRun does not cap.
    for (let i = 0; i < 150; i++) {
      const user = await createUser({
        email: `returner${i}@example-user.co.uk`,
        plainPassword: 'Passw0rd',
        verified: true,
        lastLogin: new Date(),
      })
      await db.insert(schema.retentionNotices).values({ userId: user.id, stage: 'warning-60d' })
    }

    const result = await sweep.run()

    expect(result.result.clearedNotices).toBe(150)
    const left = await db.select().from(schema.retentionNotices).all()
    expect(left).toHaveLength(0)
  })
})

describe('retention sweep: the guest cohort needs every app to answer', () => {
  it('anonymises no guest when no app is registered to answer', async () => {
    const guest = await ancientGuest('guest-none@example-user.co.uk')
    config.dryRun = false

    const result = await sweep.run()

    expect(result.result.guestSignalsOk).toBe(false)
    expect(result.result.anonymiseGuest).toBe(0)
    const row = await db.select().from(schema.users).where(eq(schema.users.id, guest.id)).get()
    expect(row!.email).toBe('guest-none@example-user.co.uk')
  })

  it('anonymises no guest when one registered app has hooks turned off', async () => {
    // The silent app is the one guest activity comes from, so an answer from
    // the others proves nothing.
    await registerApp('proscenium', { hooksEnabled: false })
    await registerApp('rooms')
    await db.insert(schema.serviceTokens).values({ name: 'rooms', tokenHash: 'hash-r' })
    const guest = await ancientGuest('guest-off@example-user.co.uk')
    config.dryRun = false
    fetchMock.mockResolvedValue({})

    const result = await sweep.run()

    expect(result.result.guestSignalsOk).toBe(false)
    expect(result.result.anonymiseGuest).toBe(0)
    const row = await db.select().from(schema.users).where(eq(schema.users.id, guest.id)).get()
    expect(row!.email).toBe('guest-off@example-user.co.uk')
  })

  it('anonymises a dormant guest once every registered app has answered', async () => {
    await registerApp('proscenium')
    await registerApp('rooms')
    await db.insert(schema.serviceTokens).values([
      { name: 'proscenium', tokenHash: 'hash-p' },
      { name: 'rooms', tokenHash: 'hash-r' },
    ])
    const guest = await ancientGuest('guest-gone@example-user.co.uk')
    config.dryRun = false
    fetchMock.mockResolvedValue({})

    const result = await sweep.run()

    expect(result.result.guestSignalsOk).toBe(true)
    expect(result.result.anonymiseGuest).toBe(1)
    const row = await db.select().from(schema.users).where(eq(schema.users.id, guest.id)).get()
    expect(row!.email).toBe(`deleted-${guest.id}@anonymised.invalid`)
  })
})

describe('retention sweep: a stalled erasure is re-driven even in dry-run', () => {
  it('finishes an erasure the member already asked for while the sweep is unarmed', async () => {
    await registerApp('rooms')
    await db.insert(schema.serviceTokens).values({ name: 'rooms', tokenHash: 'hash-r' })
    const user = await createUser({ email: 'left@example-user.co.uk', plainPassword: 'Passw0rd' })

    // Self-service erasure on a day the app was down.
    fetchMock.mockRejectedValue(new Error('rooms is down'))
    await eraseUser(user.id, { id: user.id, via: 'self-service' })

    fetchMock.mockResolvedValue({ ok: true })
    const result = await sweep.run()

    expect(result.result.dryRun).toBe(true)
    expect(result.result.outstandingErasures).toBe(1)
    expect(result.result.incompleteErasures).toBe(0)

    const audit = await db.select().from(schema.auditLog)
      .where(eq(schema.auditLog.target, user.id)).all()
    expect(audit.some(a => a.action === 'user.erased')).toBe(true)
  })
})

describe('retention sweep: one bad recipient does not abort the run', () => {
  it('counts the failure, warns everyone else, and still anonymises', async () => {
    await registerApp('rooms')
    await db.insert(schema.serviceTokens).values({ name: 'rooms', tokenHash: 'hash-r' })

    const dormant = new Date(Date.now() - 3 * 365 * DAY)
    await createUser({ email: 'bad@example-user.co.uk', plainPassword: 'Passw0rd', verified: true, lastLogin: dormant, createdAt: dormant })
    await createUser({ email: 'good@example-user.co.uk', plainPassword: 'Passw0rd', verified: true, lastLogin: dormant, createdAt: dormant })
    const doomed = await longDormant('doomed@example-user.co.uk')

    config.dryRun = false
    fetchMock.mockResolvedValue({ ok: true })
    failWarningsTo.add('bad@example-user.co.uk')

    const result = await sweep.run()

    expect(result.result.sendFailures).toBe(1)
    expect(result.result.anonymiseFull).toBe(1)

    // The failed recipient keeps no notice, so tomorrow's run warns them again.
    const notices = await db.select().from(schema.retentionNotices).all()
    expect(notices.some(n => n.userId === doomed.id)).toBe(false)
    expect(notices).toHaveLength(1)

    const audit = await db.select().from(schema.auditLog)
      .where(eq(schema.auditLog.action, 'retention.sweep')).all()
    expect(audit).toHaveLength(1)
  })

  it('marks a disabled account warned without attempting a send', async () => {
    const dormant = new Date(Date.now() - 3 * 365 * DAY)
    const off = await createUser({ email: 'off@example-user.co.uk', plainPassword: 'Passw0rd', disabled: true, lastLogin: dormant, createdAt: dormant })

    config.dryRun = false
    await sweep.run()

    expect(sentEmails.filter(e => e.kind === 'retention-warning')).toHaveLength(0)
    const notices = await db.select().from(schema.retentionNotices).all()
    expect(notices.map(n => n.userId)).toEqual([off.id])
  })
})
