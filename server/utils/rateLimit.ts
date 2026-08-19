/**
 * D1-backed fixed-window rate limiting (ADR-0009). Stale rows are swept by
 * the `rate-limits:sweep` task.
 */

import type { H3Event } from 'h3'
import { db, schema } from '@nuxthub/db'
import { lt, sql } from 'drizzle-orm'

export interface RateLimitRule {
  /** Maximum requests per window. */
  limit: number
  /** Window length in ms. */
  windowMs: number
}

/**
 * Limits per endpoint (docs/api-reference.md marks which endpoints are [RL]).
 * Generous for real users, hostile to scripts — the estate is small.
 */
export const RATE_LIMITS = {
  'login:ip': { limit: 20, windowMs: 15 * 60_000 },
  'login:acct': { limit: 10, windowMs: 15 * 60_000 },
  'register:ip': { limit: 10, windowMs: 60 * 60_000 },
  'register:acct': { limit: 5, windowMs: 60 * 60_000 },
  'forgot:ip': { limit: 10, windowMs: 60 * 60_000 },
  'forgot:acct': { limit: 3, windowMs: 60 * 60_000 },
  'reset:ip': { limit: 10, windowMs: 60 * 60_000 },
  'verify-request:ip': { limit: 5, windowMs: 60 * 60_000 },
  'verify-request:acct': { limit: 3, windowMs: 60 * 60_000 },
  // Second-factor attempts. Tight per-account: this is where a stolen
  // password meets a 6-digit code, and recovery codes share the endpoint.
  'magic:ip': { limit: 10, windowMs: 60 * 60_000 },
  'magic:acct': { limit: 3, windowMs: 60 * 60_000 },
  'mfa:ip': { limit: 30, windowMs: 15 * 60_000 },
  'mfa:acct': { limit: 8, windowMs: 15 * 60_000 },
  // An app pinging after deploy. Generous enough for a retried release, tight
  // enough that a deploy loop cannot hammer the poller (ADR-0018).
  'manifest-ping:app': { limit: 12, windowMs: 60 * 60_000 },
} as const satisfies Record<string, RateLimitRule>

export type RateLimitScope = keyof typeof RATE_LIMITS

/** Best-effort client IP: Cloudflare header in production, forwarded/local in dev. */
export function getClientIP(event: H3Event): string {
  return getRequestHeader(event, 'cf-connecting-ip')
    || getRequestHeader(event, 'x-forwarded-for')?.split(',')[0]?.trim()
    || '127.0.0.1'
}

/**
 * Counts a hit and throws 429 once over the limit. The 429 carries no detail
 * beyond Too Many Requests.
 */
export async function enforceRateLimit(scope: RateLimitScope, subject: string): Promise<void> {
  const { limit, windowMs } = RATE_LIMITS[scope]
  const key = `${scope}:${subject}`
  const now = Date.now()

  // Atomic upsert: start a new window, or increment within the current one.
  // The `count` branch resets to 1 when the stored window has lapsed.
  const [row] = await db.insert(schema.rateLimits)
    .values({ key, windowStart: now, count: 1 })
    .onConflictDoUpdate({
      target: schema.rateLimits.key,
      set: {
        count: sql`CASE WHEN ${schema.rateLimits.windowStart} < ${now - windowMs} THEN 1 ELSE ${schema.rateLimits.count} + 1 END`,
        windowStart: sql`CASE WHEN ${schema.rateLimits.windowStart} < ${now - windowMs} THEN ${now} ELSE ${schema.rateLimits.windowStart} END`,
      },
    })
    .returning()

  if (row && row.count > limit) {
    throw createError({
      statusCode: 429,
      statusMessage: 'Too many requests. Please try again later.',
    })
  }
}

/** Delete counters whose window lapsed more than a day ago. Returns rows removed. */
export async function sweepRateLimits(): Promise<number> {
  const cutoff = Date.now() - 24 * 60 * 60_000
  const deleted = await db.delete(schema.rateLimits)
    .where(lt(schema.rateLimits.windowStart, cutoff))
    .returning({ key: schema.rateLimits.key })
  return deleted.length
}
