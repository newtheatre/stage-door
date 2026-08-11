import { describe, expect, it, vi, afterEach } from 'vitest'
import { hasRole, hasAnyRole, isStale, ROLE_STALENESS_MS } from '../packages/auth-types'

describe('role helpers', () => {
  const user = { roles: ['proscenium:ADMIN', 'rooms:ADMIN', 'auth:ADMIN'] }

  it('hasRole matches exact scoped strings', () => {
    expect(hasRole(user, 'rooms', 'ADMIN')).toBe(true)
    expect(hasRole(user, 'rooms', 'MANAGER')).toBe(false)
    expect(hasRole(user, 'photos', 'ADMIN')).toBe(false)
  })

  it('hasRole handles missing users and empty roles', () => {
    expect(hasRole(null, 'rooms', 'ADMIN')).toBe(false)
    expect(hasRole(undefined, 'rooms', 'ADMIN')).toBe(false)
    expect(hasRole({ roles: [] }, 'rooms', 'ADMIN')).toBe(false)
  })

  it('hasAnyRole matches any of the given roles in the namespace', () => {
    expect(hasAnyRole(user, 'proscenium', 'MANAGER', 'ADMIN')).toBe(true)
    expect(hasAnyRole(user, 'proscenium', 'MANAGER', 'BOX_OFFICE')).toBe(false)
  })

  it('does not treat a role in one namespace as matching another', () => {
    expect(hasRole({ roles: ['rooms:ADMIN'] }, 'proscenium', 'ADMIN')).toBe(false)
  })
})

describe('isStale', () => {
  afterEach(() => vi.useRealTimers())

  it('fresh session is not stale', () => {
    expect(isStale({ refreshedAt: Date.now() })).toBe(false)
  })

  it('session older than the window is stale', () => {
    expect(isStale({ refreshedAt: Date.now() - ROLE_STALENESS_MS - 1 })).toBe(true)
  })

  it('negative age (clock skew) counts as stale', () => {
    expect(isStale({ refreshedAt: Date.now() + 60_000 })).toBe(true)
  })

  it('missing session or refreshedAt is stale', () => {
    expect(isStale(null)).toBe(true)
    expect(isStale(undefined)).toBe(true)
    expect(isStale({} as never)).toBe(true)
  })
})
