# ADR-0009: Rate limiting via D1-backed fixed-window counters

**Status:** Accepted · **Date:** 2026-08-11 · **Deciders:** Matt Adcock (ITM 26/27), implemented with Claude Code

## Context

The implementation plan left the rate-limiting mechanism open between two acceptable options: a D1-backed `rate_limits` table, or Cloudflare's free WAF rate rules on `auth.newtheatre.org.uk/api/auth/*`. The choice had to be made at build time (Phase 1) and recorded.

## Decision

Rate limiting is implemented **in code, as fixed-window counters in the `rate_limits` D1 table** (`server/utils/rateLimit.ts`). One row per key (`<scope>:<subject>`, e.g. `login:ip:1.2.3.4`, `login:acct:alice@example.com`); the window resets in place via a single atomic upsert; over-limit requests get a bare 429. Limits per endpoint live in the `RATE_LIMITS` map in that file. A nightly Nitro scheduled task (`rate-limits:sweep`, cron trigger `0 3 * * *`) deletes counters whose window lapsed over a day ago.

## Alternatives considered

- **Cloudflare WAF rate rules** — genuinely less code, but the limits become invisible to the repo: not versioned, not testable, not visible in local dev, and dependent on dashboard state a successor can't discover from the code. For an estate whose bus-factor reduction is a stated goal, config-as-dashboard lost.
- **KV/Durable Object counters** — more precise (sliding windows), but adds a new platform primitive to a service that otherwise only needs D1. Fixed windows are coarse yet entirely adequate for login/register/forgot abuse on an estate this size.

## Consequences

Good: limits are code-reviewed, unit-tested (`tests/rate-limit.test.ts`), identical in dev and production, and per-account limiting (which WAF rules can't do — they never see the request body) works. Bad: every rate-limited request costs one D1 write; at NNT traffic this is noise, but if the service ever fronts real load, revisit (WAF rules can be layered on top without touching code). The fixed window admits up to 2× the limit across a window boundary — accepted; the limits are sized with headroom.
