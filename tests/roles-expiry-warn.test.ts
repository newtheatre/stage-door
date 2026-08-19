import { describe, expect, it } from 'vitest'
import { db, schema } from '@nuxthub/db'
import { eq } from 'drizzle-orm'
import expiryWarnTask from '../server/tasks/roles/expiry-warn'
import { sentEmails } from './setup'
import { activeRoleCondition } from '../server/utils/session'
import { createUser, grantRole } from './helpers/users'

const runTask = () => (expiryWarnTask as unknown as { run: () => Promise<{ result: Record<string, number> }> }).run()

const DAY = 24 * 60 * 60 * 1000

describe('roles:expiry-warn task', () => {
  it('warns each holder once, digests to the ITM, and marks the grants', async () => {
    const holder = await createUser({ email: 'holder@example-user.co.uk', plainPassword: 'Passw0rd' })
    await grantRole(holder.id, 'rooms:ADMIN', { expiresAt: new Date(Date.now() + 7 * DAY) })
    await grantRole(holder.id, 'proscenium:BOX_OFFICE', { expiresAt: new Date(Date.now() + 10 * DAY) })
    // Not in the window / not dated — untouched.
    await grantRole(holder.id, 'proscenium:MANAGER', { expiresAt: new Date(Date.now() + 100 * DAY) })
    const other = await createUser({ email: 'other@example-user.co.uk', plainPassword: 'Passw0rd' })
    await grantRole(other.id, 'auth:ADMIN')

    const { result } = await runTask()

    expect(result.warnedGrants).toBe(2)
    expect(result.warnedHolders).toBe(1)
    // One holder email covering both grants + one digest.
    const warnings = sentEmails.filter(e => e.kind === 'role-expiry-warning')
    expect(warnings).toHaveLength(1)
    expect(warnings[0]!.to).toBe('holder@example-user.co.uk')
    expect(warnings[0]!.token).toContain('rooms:ADMIN')
    expect(warnings[0]!.token).toContain('proscenium:BOX_OFFICE')
    expect(sentEmails.filter(e => e.kind === 'role-expiry-digest')).toHaveLength(1)

    // Second run: nothing new.
    sentEmails.length = 0
    const second = await runTask()
    expect(second.result.warnedGrants).toBe(0)
    expect(sentEmails).toHaveLength(0)
  })

  it('a renewal re-arms the warning for the new expiry', async () => {
    const holder = await createUser({ email: 'holder@example-user.co.uk', plainPassword: 'Passw0rd' })
    await grantRole(holder.id, 'rooms:ADMIN', {
      expiresAt: new Date(Date.now() + 7 * DAY),
      expiryWarnedAt: new Date(), // already warned for this expiry
    })

    let { result } = await runTask()
    expect(result.warnedGrants).toBe(0)

    // Renewal: roles.put clears expiryWarnedAt when expiry changes —
    // simulate its effect, with the new date inside the window again.
    await db.update(schema.userRoles)
      .set({ expiresAt: new Date(Date.now() + 12 * DAY), expiryWarnedAt: null })
      .where(eq(schema.userRoles.userId, holder.id))

    ;({ result } = await runTask())
    expect(result.warnedGrants).toBe(1)
  })

  it('disabled and anonymised holders are marked warned without an email', async () => {
    const disabled = await createUser({ email: 'off@example-user.co.uk', plainPassword: 'Passw0rd', disabled: true })
    await grantRole(disabled.id, 'rooms:ADMIN', { expiresAt: new Date(Date.now() + 5 * DAY) })
    const anonymised = await createUser({ email: 'deleted-x@anonymised.invalid' })
    await grantRole(anonymised.id, 'ticketing:ADMIN', { expiresAt: new Date(Date.now() + 5 * DAY) })

    const { result } = await runTask()

    expect(result.warnedGrants).toBe(2)
    expect(sentEmails.filter(e => e.kind === 'role-expiry-warning')).toHaveLength(0)
    expect(sentEmails.filter(e => e.kind === 'role-expiry-digest')).toHaveLength(0)

    const rows = await db.select().from(schema.userRoles).all()
    expect(rows.every(r => r.expiryWarnedAt !== null)).toBe(true)
  })

  it('cleanup deletes only rows expired longer than the threshold', async () => {
    const holder = await createUser({ email: 'holder@example-user.co.uk', plainPassword: 'Passw0rd' })
    await grantRole(holder.id, 'old:ROLE', { expiresAt: new Date(Date.now() - 100 * DAY) })
    await grantRole(holder.id, 'recent:ROLE', { expiresAt: new Date(Date.now() - 10 * DAY) })
    await grantRole(holder.id, 'active:ROLE')

    const { result } = await runTask()

    expect(result.cleaned).toBe(1)
    const remaining = (await db.select().from(schema.userRoles).all()).map(r => r.role).sort()
    expect(remaining).toEqual(['active:ROLE', 'recent:ROLE'])
  })
})

describe('the warned-at update stays inside D1 limits', () => {
  it('marks every grant when a whole committee year lapses at once', async () => {
    // 120 grants in one run: an unchunked inArray would bind 120 parameters
    // and D1 caps a statement at 100.
    const holders = []
    for (let i = 0; i < 120; i++) {
      const holder = await createUser({ email: `bulk${i}@example-user.co.uk`, plainPassword: 'Passw0rd' })
      await grantRole(holder.id, 'rooms:ADMIN', { expiresAt: new Date(Date.now() + 7 * DAY) })
      holders.push(holder)
    }

    const { result } = await runTask()
    expect(result.warnedGrants).toBe(120)

    const unwarned = (await db.select().from(schema.userRoles).all())
      .filter(r => r.expiryWarnedAt === null)
    expect(unwarned).toHaveLength(0)

    // Second run finds nothing left to do, so no grant was warned twice.
    const second = await runTask()
    expect(second.result.warnedGrants).toBe(0)
  })
})

describe('retention sweep exemption uses ACTIVE roles only', () => {
  it('sweep-side condition excludes expired grants', async () => {
    const activeHolder = await createUser({ email: 'active@example-user.co.uk', plainPassword: 'Passw0rd' })
    await grantRole(activeHolder.id, 'rooms:ADMIN')
    const expiredHolder = await createUser({ email: 'lapsed@example-user.co.uk', plainPassword: 'Passw0rd' })
    await grantRole(expiredHolder.id, 'rooms:ADMIN', { expiresAt: new Date(Date.now() - DAY) })

    const rows = await db.select({ userId: schema.userRoles.userId })
      .from(schema.userRoles).where(activeRoleCondition(new Date())).all()
    const holders = new Set(rows.map(r => r.userId))

    expect(holders.has(activeHolder.id)).toBe(true)
    expect(holders.has(expiredHolder.id)).toBe(false)
  })
})
