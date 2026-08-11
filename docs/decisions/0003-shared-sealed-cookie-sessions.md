# ADR-0003: SSO via shared sealed cookie on `.newtheatre.org.uk`

**Status:** Accepted · **Date:** 2026-08-09 · **Deciders:** Matt Adcock (ITM 26/27)

## Context

Consumer apps need to know who's logged in on every request. Options ranged from full OIDC (tokens, callbacks per app) to server-side sessions (DB hit per request) to the nuxt-auth-utils native model: a stateless cookie sealed with a shared secret, readable by any holder of that secret.

## Decision

One session cookie (`nnt-session`) scoped to `.newtheatre.org.uk`, sealed with a single `NUXT_SESSION_PASSWORD` shared by the auth service and every consumer app. Only the auth service writes it; apps unseal locally with `getUserSession()` — no network call. Revocation is handled by a two-part scheme: a per-user `session_epoch` (bump = force logout) enforced at `/api/session/refresh`, and a 15-minute staleness rule on privileged surfaces that forces periodic refresh.

## Alternatives considered

- **OIDC/token flows per app** — proper separation, per-app revocation; lost on complexity: every app needs a client, callback, token refresh, and session-of-its-own anyway.
- **Server-side sessions (D1/KV lookup per request)** — instant revocation; lost because it puts the auth service (or a shared store) on the hot path of every request of every app, for a revocation window nobody at this scale needs to be zero.

## Consequences

Good: integration is config, not code; zero added latency; offline-tolerant (auth service down ≠ estate down). Bad, accepted with eyes open: **any worker holding the secret can forge any session** — mitigated by the tiny secret-holder set, worker-secret-only storage, and a one-command-per-app rotation drill; **revocation is bounded, not instant** — ≤15 min on privileged surfaces, up to cookie expiry on unprivileged reads unless epoch-bumped. Consumer-app XSS gains the victim's estate-wide session (documented in security.md; apps inherit escaping discipline). If the estate ever includes an app that can't be trusted with the secret, that app must integrate via OIDC instead — which would be the trigger to revisit this ADR.
