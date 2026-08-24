/**
 * Grants that reference nothing an app reads (ADR-0023). The distinction that
 * matters: `ticketing:*` has no definition on purpose, `app:ROLE` by accident.
 */

import { describe, expect, it } from 'bun:test'
import { db, schema } from '@nuxthub/db'
import { eq } from 'drizzle-orm'
import { findSuspectGrants } from '../server/utils/grantAudit'
import { createUser, grantRole, defineRole, registerApp } from './helpers/users'

const DAY = 24 * 60 * 60 * 1000

async function holderOf(role: string, email: string) {
  const user = await createUser({ email, plainPassword: 'Passw0rd' })
  await grantRole(user.id, role)
  return user
}

describe('suspect grants', () => {
  it('never flags a dormant namespace, which is history by design', async () => {
    await holderOf('ticketing:BOX_OFFICE', 'legacy@example-user.co.uk')

    expect(await findSuspectGrants()).toEqual([])
  })

  it('flags a typo whose namespace belongs to no app', async () => {
    await holderOf('app:ROLE', 'typo@example-user.co.uk')

    expect(await findSuspectGrants()).toEqual([
      { role: 'app:ROLE', holders: 1, problem: 'unknown-namespace' },
    ])
  })

  it('flags a role a registered app does not declare', async () => {
    await registerApp('rooms')
    await holderOf('rooms:SUPERVISOR', 'wrong@example-user.co.uk')

    expect(await findSuspectGrants()).toEqual([
      { role: 'rooms:SUPERVISOR', holders: 1, problem: 'undefined-role' },
    ])
  })

  it('flags a withdrawn definition and counts its holders', async () => {
    await registerApp('rooms')
    await defineRole('rooms', 'ADMIN')
    await db.update(schema.roleDefinitions).set({ withdrawnAt: new Date() })
      .where(eq(schema.roleDefinitions.role, 'ADMIN'))
    await holderOf('rooms:ADMIN', 'kept-a@example-user.co.uk')
    await holderOf('rooms:ADMIN', 'kept-b@example-user.co.uk')

    expect(await findSuspectGrants()).toEqual([
      { role: 'rooms:ADMIN', holders: 2, problem: 'withdrawn' },
    ])
  })

  it('says nothing about a healthy grant, or this service own namespace', async () => {
    await registerApp('rooms')
    await defineRole('rooms', 'ADMIN')
    await defineRole('auth', 'ADMIN')
    await holderOf('rooms:ADMIN', 'fine@example-user.co.uk')
    await holderOf('auth:ADMIN', 'itm@example-user.co.uk')

    expect(await findSuspectGrants()).toEqual([])
  })

  it('ignores expired grants and anonymised holders', async () => {
    const lapsed = await createUser({ email: 'lapsed@example-user.co.uk', plainPassword: 'Passw0rd' })
    await grantRole(lapsed.id, 'app:ROLE', { expiresAt: new Date(Date.now() - DAY) })
    // Anonymised placeholder: its grants are not a live problem.
    const erased = await createUser({ email: 'erased-x@example.invalid' })
    await grantRole(erased.id, 'app:ROLE')

    expect(await findSuspectGrants()).toEqual([])
  })

  it('orders worst first, so a typo outranks a withdrawal', async () => {
    await registerApp('rooms')
    await defineRole('rooms', 'ADMIN')
    await db.update(schema.roleDefinitions).set({ withdrawnAt: new Date() })
    await holderOf('rooms:ADMIN', 'w@example-user.co.uk')
    await holderOf('app:ROLE', 't@example-user.co.uk')

    expect((await findSuspectGrants()).map(s => s.problem)).toEqual(['unknown-namespace', 'withdrawn'])
  })
})
