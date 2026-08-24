import { afterEach, describe, expect, it } from 'bun:test'
import { db, schema } from '@nuxthub/db'
import { eq } from 'drizzle-orm'
import sweepTask from '../server/tasks/retention/sweep'
import { RETENTION_CONFIG } from '../server/utils/retentionConfig'
import { fetchMock } from './setup'
import { createUser, registerApp } from './helpers/users'

const sweep = sweepTask as unknown as { run: () => Promise<{ result: Record<string, number> }> }

// The config is a module singleton the task reads through the auto-import.
const config = RETENTION_CONFIG as unknown as { dryRun: boolean }

afterEach(() => {
  config.dryRun = true
})

const DAY = 24 * 60 * 60 * 1000

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
