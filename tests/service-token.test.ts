import { describe, expect, it } from 'vitest'
import { db, schema } from '@nuxthub/db'
import { createServiceToken, hashServiceToken, requireServiceToken } from '../server/utils/serviceToken'
import shadowHandler from '../server/api/users/shadow.post'
import { makeEvent } from './setup'
import { createUser } from './helpers/users'

const shadow = shadowHandler as unknown as (event: unknown) => Promise<{ id: string, existing: boolean, guest: boolean }>

describe('service tokens: CLAUDE.md invariant 10', () => {
  it('stores only the SHA-256, never the plaintext', async () => {
    const { token } = await createServiceToken('proscenium')

    expect(token).toMatch(/^nnt_svc_/)
    const [row] = await db.select().from(schema.serviceTokens).all()
    expect(row!.tokenHash).toBe(hashServiceToken(token))
    expect(row!.tokenHash).not.toContain(token)
  })

  it('authenticates a valid bearer and stamps last_used_at', async () => {
    const { token } = await createServiceToken('proscenium')

    const row = await requireServiceToken(makeEvent({ headers: { authorization: `Bearer ${token}` } }))
    expect(row.name).toBe('proscenium')

    const [stored] = await db.select().from(schema.serviceTokens).all()
    expect(stored!.lastUsedAt).not.toBeNull()
  })

  it('rejects missing, malformed, and unknown tokens alike', async () => {
    await createServiceToken('proscenium')

    for (const headers of [
      {},
      { authorization: 'Bearer wrong-prefix' },
      { authorization: `Bearer nnt_svc_${'a'.repeat(43)}` },
    ]) {
      await expect(requireServiceToken(makeEvent({ headers })))
        .rejects.toMatchObject({ statusCode: 401, statusMessage: 'Invalid service token' })
    }
  })
})

describe('POST /api/users/shadow: guest checkout (ADR-0007)', () => {
  let tokenCounter = 0

  async function call(body: Record<string, unknown>) {
    tokenCounter += 1
    const { token } = await createServiceToken(`proscenium-${tokenCounter}`)
    return shadow(makeEvent({ body, headers: { authorization: `Bearer ${token}` } }))
  }

  it('creates a password-less user and audits it', async () => {
    const result = await call({ email: 'Booker@Example.com', name: 'Guest Booker' })

    expect(result.existing).toBe(false)
    expect(result.guest).toBe(true)

    const [user] = await db.select().from(schema.users).all()
    expect(user!.email).toBe('booker@example.com')
    expect(user!.password).toBeNull()
    expect(user!.verified).toBe(false)

    const audit = await db.select().from(schema.auditLog).all()
    expect(audit.map(a => a.action)).toContain('user.shadow-created')
  })

  it('is idempotent by email and returns the existing id', async () => {
    const first = await call({ email: 'booker@example.com', name: 'Guest' })
    const second = await call({ email: 'BOOKER@example.com', name: 'Different Name' })

    expect(second.id).toBe(first.id)
    expect(second.existing).toBe(true)
    expect(second.guest).toBe(true)

    const all = await db.select().from(schema.users).all()
    expect(all).toHaveLength(1)
  })

  it('returns a full account unchanged: booking attaches to their history', async () => {
    const full = await createUser({ email: 'member@example.com', plainPassword: 'Passw0rd', name: 'Member' })

    const result = await call({ email: 'member@example.com', name: 'Walk-up Name' })

    expect(result).toEqual({ id: full.id, existing: true, guest: false })
    const [row] = await db.select().from(schema.users).all()
    expect(row!.name).toBe('Member') // untouched
  })

  it('rejects calls without a service token', async () => {
    await expect(shadow(makeEvent({ body: { email: 'x@example.com', name: 'X' } })))
      .rejects.toMatchObject({ statusCode: 401 })
  })
})

describe('a malformed token is rejected, not an error', () => {
  it('rejects a token whose hash length differs rather than throwing', async () => {
    await createServiceToken('proscenium')

    // timingSafeEqual throws on a length mismatch; without a guard this 500s.
    const event = makeEvent({ headers: { authorization: 'Bearer nnt_svc_short' } })
    await expect(requireServiceToken(event)).rejects.toMatchObject({ statusCode: 401 })
  })
})
