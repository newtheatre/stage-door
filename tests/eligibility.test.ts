/**
 * Training-conditional grants (ADR-0019). The chosen failure direction: an
 * outage or a never-answered rule leaves the grant alone.
 */

import { describe, expect, it } from 'bun:test'
import { db, schema } from '@nuxthub/db'
import { and, eq } from 'drizzle-orm'
import { loadRoles, loadRoleGrants, effectiveRoleCondition } from '../server/utils/session'
import { createUser, grantRole, defineRole, registerApp, enrolTotp } from './helpers/users'
import definitionsListHandler from '../server/api/role-definitions/index.get'
import { snapshotRule, referencedRuleKeys, staleRules, SNAPSHOT_STALE_MS } from '../server/utils/eligibility'
import snapshotTask from '../server/tasks/eligibility/snapshot'
import { assertEligibilityModeAllowed } from '../server/utils/roleDefinitions'
import { fetchMock, makeEvent, runtimeConfig, sentEmails } from './setup'

type DefinitionRow = { role: string, requiresEligibilityKey: string | null, eligibilityMode: string }
const listDefinitions = definitionsListHandler as unknown as (event: unknown) => Promise<{ definitions: DefinitionRow[] }>

const DAY = 24 * 60 * 60 * 1000

async function conditionalRole(mode: 'advisory' | 'enforcing', key = 'duty-manager') {
  await defineRole('proscenium', 'DUTY_MANAGER')
  await db.update(schema.roleDefinitions)
    .set({ requiresEligibilityKey: key, eligibilityMode: mode })
    .where(eq(schema.roleDefinitions.role, 'DUTY_MANAGER'))
}

async function ruleAnswered(key = 'duty-manager', eligibleUserIds: string[] = []) {
  await db.insert(schema.eligibilitySyncs)
    .values({ ruleKey: key, lastAttemptAt: new Date(), lastSuccessAt: new Date(), userCount: eligibleUserIds.length })
  for (const userId of eligibleUserIds) {
    await db.insert(schema.eligibilitySnapshots).values({ ruleKey: key, userId, capturedAt: new Date() })
  }
}

describe('loadRoles binds a fixed number of parameters', () => {
  it('does not grow with grants, definitions, rules or snapshot rows (D1 caps at 100)', () => {
    const query = db.select({ role: schema.userRoles.role }).from(schema.userRoles)
      .where(and(eq(schema.userRoles.userId, 'x'), effectiveRoleCondition(new Date())))

    // userId, activeRoleCondition's now, and the override cutoff. Three, forever.
    expect(query.toSQL().params).toHaveLength(3)
  })
})

describe('an enforcing prerequisite', () => {
  it('keeps the role for someone the snapshot says is eligible', async () => {
    const user = await createUser({ email: 'qualified@example.com', plainPassword: 'Passw0rd' })
    await conditionalRole('enforcing')
    await grantRole(user.id, 'proscenium:DUTY_MANAGER')
    await ruleAnswered('duty-manager', [user.id])

    expect(await loadRoles(user.id)).toEqual(['proscenium:DUTY_MANAGER'])
  })

  it('makes the grant inert for someone absent from the snapshot', async () => {
    const user = await createUser({ email: 'lapsed@example.com', plainPassword: 'Passw0rd' })
    await conditionalRole('enforcing')
    await grantRole(user.id, 'proscenium:DUTY_MANAGER')
    await ruleAnswered('duty-manager', [])

    expect(await loadRoles(user.id)).toEqual([])
  })

  it('does not engage on a rule that has never been answered', async () => {
    const user = await createUser({ email: 'unknown@example.com', plainPassword: 'Passw0rd' })
    await conditionalRole('enforcing')
    await grantRole(user.id, 'proscenium:DUTY_MANAGER')
    // No eligibility_syncs row: a configuration mistake must not lock the estate out.

    expect(await loadRoles(user.id)).toEqual(['proscenium:DUTY_MANAGER'])
  })

  it('uses the last good snapshot when a later sync failed', async () => {
    const user = await createUser({ email: 'outage@example.com', plainPassword: 'Passw0rd' })
    await conditionalRole('enforcing')
    await grantRole(user.id, 'proscenium:DUTY_MANAGER')
    await ruleAnswered('duty-manager', [user.id])

    // rehearsal goes down: the error is stamped, the snapshot is untouched.
    await db.update(schema.eligibilitySyncs)
      .set({ lastAttemptAt: new Date(), lastError: 'connect ECONNREFUSED' })

    expect(await loadRoles(user.id)).toEqual(['proscenium:DUTY_MANAGER'])
  })

  it('is lifted by a live override and re-applies once it lapses', async () => {
    const user = await createUser({ email: 'override@example.com', plainPassword: 'Passw0rd' })
    await conditionalRole('enforcing')
    await grantRole(user.id, 'proscenium:DUTY_MANAGER')
    await ruleAnswered('duty-manager', [])

    await db.update(schema.userRoles).set({ eligibilityOverrideUntil: new Date(Date.now() + DAY) })
    expect(await loadRoles(user.id)).toEqual(['proscenium:DUTY_MANAGER'])

    await db.update(schema.userRoles).set({ eligibilityOverrideUntil: new Date(Date.now() - DAY) })
    expect(await loadRoles(user.id)).toEqual([])
  })
})

describe('the admin surfaces can explain an inert grant', () => {
  it('reports inert and overrideUntil on the grant, so it is not silently absent', async () => {
    const user = await createUser({ email: 'inert@example.com', plainPassword: 'Passw0rd' })
    await conditionalRole('enforcing')
    await grantRole(user.id, 'proscenium:DUTY_MANAGER')
    await ruleAnswered('duty-manager', [])

    const [grant] = await loadRoleGrants(user.id)
    expect(grant).toMatchObject({ role: 'proscenium:DUTY_MANAGER', expired: false, inert: true, overrideUntil: null })

    const until = new Date(Date.now() + 30 * DAY)
    await db.update(schema.userRoles).set({ eligibilityOverrideUntil: until })
      .where(eq(schema.userRoles.userId, user.id))

    const [lifted] = await loadRoleGrants(user.id)
    expect(lifted).toMatchObject({ inert: false, overrideUntil: until.getTime() })
  })

  it('names the prerequisite on the role-definitions list', async () => {
    await conditionalRole('enforcing')

    const admin = await createUser({ email: 'defs-admin@example.com', plainPassword: 'Passw0rd', verified: true })
    await grantRole(admin.id, 'auth:ADMIN')
    await enrolTotp(admin.id)
    const event = makeEvent()
    await (globalThis as never as { setUserSession: (e: unknown, s: unknown) => Promise<unknown> })
      .setUserSession(event, {
        user: { id: admin.id, email: admin.email, name: admin.name, verified: true, guest: false, roles: ['auth:ADMIN'] },
        loggedInAt: Date.now(),
        refreshedAt: Date.now(),
        epoch: 0,
      })

    const { definitions } = await listDefinitions(event)
    expect(definitions.find(d => d.role === 'DUTY_MANAGER'))
      .toMatchObject({ requiresEligibilityKey: 'duty-manager', eligibilityMode: 'enforcing' })
  })
})

describe('an advisory prerequisite never filters', () => {
  it('keeps the role even with the person absent from the snapshot', async () => {
    const user = await createUser({ email: 'advisory@example.com', plainPassword: 'Passw0rd' })
    await conditionalRole('advisory')
    await grantRole(user.id, 'proscenium:DUTY_MANAGER')
    await ruleAnswered('duty-manager', [])

    expect(await loadRoles(user.id)).toEqual(['proscenium:DUTY_MANAGER'])
  })
})

describe('grants without a definition are unaffected', () => {
  it('still loads a grant no definition matches, such as the dormant ticketing roles', async () => {
    const user = await createUser({ email: 'legacy@example.com', plainPassword: 'Passw0rd' })
    await grantRole(user.id, 'ticketing:BOX_OFFICE')

    expect(await loadRoles(user.id)).toEqual(['ticketing:BOX_OFFICE'])
  })

  it('leaves expiry filtering exactly as it was', async () => {
    const user = await createUser({ email: 'expired@example.com', plainPassword: 'Passw0rd' })
    await defineRole('rooms', 'ADMIN')
    await grantRole(user.id, 'rooms:ADMIN', { expiresAt: new Date(Date.now() - DAY) })

    expect(await loadRoles(user.id)).toEqual([])
  })
})

async function trainingRegistered() {
  runtimeConfig.trainingApiToken = 'nnt_trn_test'
  await registerApp('rehearsal', { namespace: 'training', baseUrl: 'https://training.newtheatre.org.uk' })
  await conditionalRole('enforcing')
}

describe('the snapshot writer', () => {
  it('replaces the snapshot without exceeding D1 bound parameters', async () => {
    await trainingRegistered()
    // 250 eligible people: unchunked this would bind 750 parameters and D1
    // caps a statement at 100.
    const userIds = Array.from({ length: 250 }, (_, i) => `person-${i}`)
    fetchMock.mockResolvedValue({ key: 'duty-manager', userIds })

    const result = await snapshotRule('duty-manager')

    expect(result).toMatchObject({ ok: true, userCount: 250 })
    expect(await db.select().from(schema.eligibilitySnapshots).all()).toHaveLength(250)
  })

  it('leaves the previous snapshot in force when rehearsal is down', async () => {
    await trainingRegistered()
    fetchMock.mockResolvedValue({ key: 'duty-manager', userIds: ['keeper'] })
    await snapshotRule('duty-manager')

    fetchMock.mockRejectedValue(new Error('connect ECONNREFUSED'))
    const result = await snapshotRule('duty-manager')

    expect(result.ok).toBe(false)
    const rows = await db.select().from(schema.eligibilitySnapshots).all()
    expect(rows.map(r => r.userId)).toEqual(['keeper'])
    const sync = await db.select().from(schema.eligibilitySyncs).get()
    // last_success_at is untouched, so enforcement keeps using the old answer.
    expect(sync!.lastSuccessAt).not.toBeNull()
    expect(sync!.lastError).toContain('ECONNREFUSED')
  })

  it('does not empty a live snapshot when rehearsal answers with no holders', async () => {
    await trainingRegistered()
    fetchMock.mockResolvedValue({ key: 'duty-manager', userIds: ['keeper', 'other'] })
    await snapshotRule('duty-manager')

    fetchMock.mockResolvedValue({ key: 'duty-manager', userIds: [] })
    const result = await snapshotRule('duty-manager')

    expect(result.ok).toBe(false)
    const rows = await db.select().from(schema.eligibilitySnapshots).all()
    expect(rows.map(r => r.userId).sort()).toEqual(['keeper', 'other'])
  })

  it('treats a malformed 200 as a failure rather than an empty set', async () => {
    await trainingRegistered()
    fetchMock.mockResolvedValue({ key: 'duty-manager', userIds: ['keeper'] })
    await snapshotRule('duty-manager')

    // No userIds at all must not read as "nobody is eligible".
    fetchMock.mockResolvedValue({ key: 'duty-manager' })
    const result = await snapshotRule('duty-manager')

    expect(result.ok).toBe(false)
    const rows = await db.select().from(schema.eligibilitySnapshots).all()
    expect(rows.map(r => r.userId)).toEqual(['keeper'])
    const sync = await db.select().from(schema.eligibilitySyncs).get()
    expect(sync!.lastSuccessAt).not.toBeNull()
  })

  it('swaps the membership over without a window where nobody is eligible', async () => {
    await trainingRegistered()
    fetchMock.mockResolvedValue({ key: 'duty-manager', userIds: ['stays', 'leaves'] })
    await snapshotRule('duty-manager')

    fetchMock.mockResolvedValue({ key: 'duty-manager', userIds: ['stays', 'joins'] })
    const result = await snapshotRule('duty-manager')

    expect(result).toMatchObject({ ok: true, userCount: 2 })
    const rows = await db.select().from(schema.eligibilitySnapshots).all()
    expect(rows.map(r => r.userId).sort()).toEqual(['joins', 'stays'])
  })

  it('only asks about rules a definition actually references', async () => {
    await trainingRegistered()
    expect(await referencedRuleKeys()).toEqual(['duty-manager'])
  })
})

describe('an enforcing prerequisite is refused on an ADMIN role', () => {
  it('refuses, because an outage would lock out the people who fix it', () => {
    expect(() => assertEligibilityModeAllowed('training', 'ADMIN', 'enforcing'))
      .toThrow(/cannot have an enforcing training prerequisite/)
    expect(() => assertEligibilityModeAllowed('auth', 'ADMIN', 'enforcing')).toThrow()
    // Advisory is fine, and so is enforcing on any non-ADMIN role.
    expect(() => assertEligibilityModeAllowed('training', 'ADMIN', 'advisory')).not.toThrow()
    expect(() => assertEligibilityModeAllowed('proscenium', 'DUTY_MANAGER', 'enforcing')).not.toThrow()
  })
})

describe('a failing snapshot is visible outside the sync table', () => {
  it('audits the failure, so enforcement on a frozen answer leaves a trail', async () => {
    await trainingRegistered()
    fetchMock.mockRejectedValue(new Error('401 Unauthorized'))

    await snapshotRule('duty-manager')

    const audit = await db.select().from(schema.auditLog)
      .where(eq(schema.auditLog.action, 'eligibility.snapshot-failed')).all()
    expect(audit).toHaveLength(1)
    expect(audit[0]!.target).toBe('duty-manager')
    expect(audit[0]!.detail).toContain('401 Unauthorized')
  })

  it('emails the digest address when a rule has not been answered in a day', async () => {
    await trainingRegistered()
    fetchMock.mockRejectedValue(new Error('401 Unauthorized'))

    const task = snapshotTask as unknown as { run: () => Promise<{ result: { failed: string[], stale: string[] } }> }
    const result = await task.run()

    expect(result.result.failed).toEqual(['duty-manager'])
    expect(result.result.stale).toEqual(['duty-manager'])
    expect(sentEmails).toEqual([{ kind: 'eligibility-stale', to: ROLES_CONFIG.digestEmail, token: 'duty-manager' }])
  })

  it('says nothing while every referenced rule was answered today', async () => {
    await trainingRegistered()
    fetchMock.mockResolvedValue({ key: 'duty-manager', userIds: ['keeper'] })

    const task = snapshotTask as unknown as { run: () => Promise<{ result: { stale: string[] } }> }
    const result = await task.run()

    expect(result.result.stale).toEqual([])
    expect(sentEmails).toHaveLength(0)
  })

  it('reports a rule whose last good answer has gone stale, failure or not', async () => {
    await conditionalRole('enforcing')
    await db.insert(schema.eligibilitySyncs).values({
      ruleKey: 'duty-manager',
      lastAttemptAt: new Date(Date.now() - 2 * DAY),
      lastSuccessAt: new Date(Date.now() - 2 * DAY),
      userCount: 3,
    })

    const stale = await staleRules()

    expect(stale.map(r => r.ruleKey)).toEqual(['duty-manager'])
    expect(Date.now() - stale[0]!.lastSuccessAt!).toBeGreaterThan(SNAPSHOT_STALE_MS)
  })
})
