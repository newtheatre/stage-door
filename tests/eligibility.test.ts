/**
 * Training-conditional grants (ADR-0019). The chosen failure direction: an
 * outage or a never-answered rule leaves the grant alone.
 */

import { describe, expect, it } from 'vitest'
import { db, schema } from '@nuxthub/db'
import { and, eq } from 'drizzle-orm'
import { loadRoles, effectiveRoleCondition } from '../server/utils/session'
import { createUser, grantRole, defineRole, registerApp } from './helpers/users'
import { snapshotRule, referencedRuleKeys } from '../server/utils/eligibility'
import { assertEligibilityModeAllowed } from '../server/utils/roleDefinitions'
import { fetchMock, runtimeConfig } from './setup'

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

describe('the snapshot writer', () => {
  async function trainingRegistered() {
    runtimeConfig.trainingApiToken = 'nnt_trn_test'
    await registerApp('rehearsal', { namespace: 'training', baseUrl: 'https://training.newtheatre.org.uk' })
    await conditionalRole('enforcing')
  }

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
