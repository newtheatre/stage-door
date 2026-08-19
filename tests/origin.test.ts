import { describe, expect, it } from 'vitest'
import { db, schema } from '@nuxthub/db'
import { eq } from 'drizzle-orm'
import originHandler from '../server/middleware/origin'
import { livenessFailure, requireAccountUser } from '../server/utils/accountGuard'
import { requireAuthAdmin } from '../server/utils/adminGuard'
import { makeEvent } from './setup'
import { createUser, grantRole, enrolTotp } from './helpers/users'

const origin = originHandler as unknown as (event: unknown) => void

function req(path: string, opts: { method?: string, origin?: string, authorization?: string } = {}) {
  return makeEvent({
    method: opts.method ?? 'POST',
    path,
    headers: {
      ...(opts.origin ? { origin: opts.origin } : {}),
      ...(opts.authorization ? { authorization: opts.authorization } : {}),
    },
  })
}

describe('the origin check is scoped by what it protects', () => {
  it('covers cookie-authenticated routes outside /api/', () => {
    expect(() => origin(req('/logout', { origin: 'https://evil.example' }))).toThrow()
  })

  it('does not let a Bearer header exempt a cookie-authenticated route', () => {
    expect(() => origin(req('/api/account/erase', {
      origin: 'https://evil.example',
      authorization: 'Bearer nnt_svc_anything',
    }))).toThrow()
  })

  it('still exempts the two service-token routes', () => {
    for (const path of ['/api/users/shadow', '/api/apps/sync']) {
      expect(() => origin(req(path, { origin: 'https://evil.example' }))).not.toThrow()
    }
  })

  it('allows the estate and rejects lookalikes', () => {
    for (const good of ['https://newtheatre.org.uk', 'https://rooms.newtheatre.org.uk']) {
      expect(() => origin(req('/api/account/password', { origin: good }))).not.toThrow()
    }
    for (const bad of ['https://evil-newtheatre.org.uk', 'https://newtheatre.org.uk.evil.com']) {
      expect(() => origin(req('/api/account/password', { origin: bad }))).toThrow()
    }
  })

  it('ignores safe methods and originless clients', () => {
    expect(() => origin(req('/api/account/password', { method: 'GET', origin: 'https://evil.example' }))).not.toThrow()
    expect(() => origin(req('/api/account/password'))).not.toThrow()
  })
})

describe('the guards share one liveness check', () => {
  it('rejects a revoked cookie identically on the account and admin surfaces', async () => {
    const user = await createUser({ email: 'revoked@example.com', plainPassword: 'Passw0rd', verified: true })
    await grantRole(user.id, 'auth:ADMIN')
    await enrolTotp(user.id)
    await db.update(schema.users).set({ sessionEpoch: 7 }).where(eq(schema.users.id, user.id))

    for (const guard of [requireAccountUser, requireAuthAdmin]) {
      const event = makeEvent({})
      await (globalThis as never as { setUserSession: (e: unknown, s: unknown) => Promise<unknown> })
        .setUserSession(event, {
          user: { id: user.id, email: user.email, name: user.name, verified: true, guest: false, roles: ['auth:ADMIN'] },
          loggedInAt: Date.now(),
          refreshedAt: Date.now(),
          epoch: 0,
        })

      await expect(guard(event as never)).rejects.toMatchObject({ statusCode: 401 })
    }
  })

  it('names the same three reasons refreshSession reports', () => {
    const live = { epoch: 3 }
    const row = { disabled: false, sessionEpoch: 3 } as never

    expect(livenessFailure(live, undefined)).toBe('gone')
    expect(livenessFailure(live, { ...row, disabled: true })).toBe('disabled')
    expect(livenessFailure({ epoch: 2 }, row)).toBe('stale-epoch')
    expect(livenessFailure(live, row)).toBeNull()
  })
})
