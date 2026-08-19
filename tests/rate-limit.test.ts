import { describe, expect, it, vi, afterEach } from 'vitest'
import { db, schema } from '@nuxthub/db'
import { enforceRateLimit, sweepRateLimits, RATE_LIMITS } from '../server/utils/rateLimit'

describe('fixed-window rate limiter (ADR-0009)', () => {
  afterEach(() => vi.useRealTimers())

  it('allows up to the limit, then throws 429', async () => {
    const { limit } = RATE_LIMITS['forgot:acct']

    for (let i = 0; i < limit; i++) {
      await expect(enforceRateLimit('forgot:acct', 'a@example.com')).resolves.toBeUndefined()
    }

    await expect(enforceRateLimit('forgot:acct', 'a@example.com'))
      .rejects.toMatchObject({ statusCode: 429 })
  })

  it('keys are independent: per-IP and per-account do not interfere', async () => {
    const { limit } = RATE_LIMITS['forgot:acct']
    for (let i = 0; i < limit; i++) {
      await enforceRateLimit('forgot:acct', 'a@example.com')
    }

    // Same scope, different subject: unaffected.
    await expect(enforceRateLimit('forgot:acct', 'b@example.com')).resolves.toBeUndefined()
    // Different scope, same subject: unaffected.
    await expect(enforceRateLimit('login:acct', 'a@example.com')).resolves.toBeUndefined()
  })

  it('resets the counter when the window rolls over', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-11T12:00:00Z'))

    const { limit, windowMs } = RATE_LIMITS['forgot:acct']
    for (let i = 0; i < limit; i++) {
      await enforceRateLimit('forgot:acct', 'a@example.com')
    }
    await expect(enforceRateLimit('forgot:acct', 'a@example.com'))
      .rejects.toMatchObject({ statusCode: 429 })

    vi.setSystemTime(new Date(Date.now() + windowMs + 1000))

    await expect(enforceRateLimit('forgot:acct', 'a@example.com')).resolves.toBeUndefined()
  })

  it('sweep removes only long-lapsed counters', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-11T12:00:00Z'))
    await enforceRateLimit('forgot:acct', 'old@example.com')

    vi.setSystemTime(new Date('2026-08-13T12:00:00Z')) // two days later
    await enforceRateLimit('forgot:acct', 'fresh@example.com')

    const removed = await sweepRateLimits()
    expect(removed).toBe(1)

    const remaining = await db.select().from(schema.rateLimits).all()
    expect(remaining.map(r => r.key)).toEqual(['forgot:acct:fresh@example.com'])
  })
})
