import { describe, expect, it } from 'bun:test'
import { db, schema } from '@nuxthub/db'
import { eq } from 'drizzle-orm'
import roleHoldersHandler from '../server/api/role-holders/index.get'
import { createServiceToken } from '../server/utils/serviceToken'
import { makeEvent } from './setup'
import { createUser, grantRole, registerApp } from './helpers/users'

const roleHolders = roleHoldersHandler as unknown as (event: unknown) => Promise<{
  namespace: string
  holders: { id: string, name: string }[]
}>

async function callAs(token: string, roles: string) {
  return roleHolders(makeEvent({ headers: { authorization: `Bearer ${token}` }, query: { roles } }))
}

describe('GET /api/role-holders resolves the namespace by name (ADR-0017)', () => {
  it('answers a token issued after registration, which carries no app_id', async () => {
    await registerApp('proscenium')
    const { token } = await createServiceToken('proscenium')
    const holder = await createUser({ email: 'staffer@example-user.co.uk', name: 'Staffer' })
    await grantRole(holder.id, 'proscenium:BOX_OFFICE')

    const answer = await callAs(token, 'BOX_OFFICE')

    expect(answer.namespace).toBe('proscenium')
    expect(answer.holders.map(h => h.name)).toEqual(['Staffer'])
  })

  it('answers a rotated token whose link died with the row that carried it', async () => {
    const app = await registerApp('proscenium')
    await db.insert(schema.serviceTokens).values({ name: 'proscenium', tokenHash: 'hash-old', appId: app.id })
    const { token } = await createServiceToken('proscenium')
    await db.delete(schema.serviceTokens).where(eq(schema.serviceTokens.tokenHash, 'hash-old'))
    const holder = await createUser({ email: 'staffer2@example-user.co.uk', name: 'Staffer Two' })
    await grantRole(holder.id, 'proscenium:BOX_OFFICE')

    const answer = await callAs(token, 'BOX_OFFICE')
    expect(answer.holders.map(h => h.name)).toEqual(['Staffer Two'])
  })

  it('403s a token whose name matches no registered app', async () => {
    const { token } = await createServiceToken('retired')

    await expect(callAs(token, 'BOX_OFFICE')).rejects.toMatchObject({ statusCode: 403 })
  })
})
