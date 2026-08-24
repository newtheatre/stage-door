import { describe, expect, it } from 'bun:test'
import { db, schema } from '@nuxthub/db'
import { eq } from 'drizzle-orm'
import loginHandler from '../server/api/auth/login.post'
import { makeEvent, sealedSession } from './setup'
import { createUser, grantRole } from './helpers/users'

const login = loginHandler as unknown as (event: unknown) => Promise<{ user: unknown }>

async function attempt(body: Record<string, unknown>, headers?: Record<string, string>) {
  const event = makeEvent({ body, headers })
  try {
    const result = await login(event)
    return { event, result, error: undefined }
  }
  catch (error) {
    return { event, result: undefined, error: error as { statusCode: number, statusMessage: string } }
  }
}

describe('POST /api/auth/login', () => {
  it('seals a contract-shaped session and stamps last_login on success', async () => {
    const user = await createUser({ email: 'alice@example.com', plainPassword: 'Passw0rd', verified: true })
    await grantRole(user.id, 'proscenium:BOX_OFFICE')

    const { event, result } = await attempt({ email: 'alice@example.com', password: 'Passw0rd' })

    expect(result?.user).toMatchObject({
      id: user.id,
      email: 'alice@example.com',
      name: 'Some One',
      verified: true,
      guest: false,
      roles: ['proscenium:BOX_OFFICE'],
    })

    const session = sealedSession(event)!
    expect(session.epoch).toBe(0)
    expect(typeof session.loggedInAt).toBe('number')
    expect(typeof session.refreshedAt).toBe('number')

    const updated = await db.select().from(schema.users).where(eq(schema.users.id, user.id)).get()
    expect(updated?.lastLogin).not.toBeNull()
  })

  it('lowercases the submitted email before matching', async () => {
    await createUser({ email: 'alice@example.com', plainPassword: 'Passw0rd' })
    const { result } = await attempt({ email: 'ALICE@Example.COM', password: 'Passw0rd' })
    expect(result?.user).toBeTruthy()
  })

  it('produces identical 401s for unknown user, wrong password, guest account, and disabled account', async () => {
    await createUser({ email: 'real@example.com', plainPassword: 'Passw0rd' })
    await createUser({ email: 'guest@example.com' }) // password NULL: shadow
    await createUser({ email: 'gone@example.com', plainPassword: 'Passw0rd', disabled: true })

    const outcomes = await Promise.all([
      attempt({ email: 'nobody@example.com', password: 'Passw0rd' }),
      attempt({ email: 'real@example.com', password: 'WrongPassw0rd' }),
      attempt({ email: 'guest@example.com', password: 'Passw0rd' }),
      attempt({ email: 'gone@example.com', password: 'Passw0rd' }),
    ])

    for (const { event, error } of outcomes) {
      expect(error).toBeTruthy()
      expect({ statusCode: error!.statusCode, statusMessage: error!.statusMessage })
        .toEqual({ statusCode: 401, statusMessage: 'Invalid email or password' })
      expect(sealedSession(event)).toBeUndefined()
    }
  })

  it('rate-limits per account across source IPs', async () => {
    await createUser({ email: 'target@example.com', plainPassword: 'Passw0rd' })

    // makeEvent gives each attempt a unique IP, so only the account limit applies.
    for (let i = 0; i < 10; i++) {
      const { error } = await attempt({ email: 'target@example.com', password: 'Wrong0Pass' })
      expect(error?.statusCode).toBe(401)
    }

    const { error } = await attempt({ email: 'target@example.com', password: 'Wrong0Pass' })
    expect(error?.statusCode).toBe(429)
  })

  it('rate-limits per IP across accounts', async () => {
    const headers = { 'cf-connecting-ip': '203.0.113.9' }

    for (let i = 0; i < 20; i++) {
      const { error } = await attempt({ email: `probe${i}@example.com`, password: 'Wrong0Pass' }, headers)
      expect(error?.statusCode).toBe(401)
    }

    const { error } = await attempt({ email: 'probe-final@example.com', password: 'Wrong0Pass' }, headers)
    expect(error?.statusCode).toBe(429)
  })
})
