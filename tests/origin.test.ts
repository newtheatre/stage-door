import { describe, expect, it } from 'vitest'
import originHandler from '../server/middleware/origin'
import { makeEvent } from './setup'

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
