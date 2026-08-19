# ADR-0001: Build on nuxt-auth-utils rather than Better Auth or OpenAuth

**Status:** Accepted · **Date:** 2026-08-09 · **Deciders:** Matt Adcock (ITM 26/27)

## Context

Both existing apps (Proscenium, rooms) already use `nuxt-auth-utils` for sessions and password hashing. The auth service needs email+password, Google OAuth, verification/reset flows, and estate-wide sessions, running on Cloudflare Workers + D1, maintained part-time by student volunteers.

## Decision

The service extends `nuxt-auth-utils`: its sealed-cookie sessions, its scrypt `hashPassword`/`verifyPassword`, its `defineOAuthGoogleEventHandler`. Verification, reset, admin, and role flows are ported from Proscenium's existing hand-rolled (and working) implementations rather than adopted from a framework.

## Alternatives considered

- **Better Auth**: richer feature set (orgs, plugins, admin) and a NuxtHub integration; lost because it introduces a second auth paradigm into an estate that already runs nuxt-auth-utils everywhere, adds a framework's worth of concepts for future maintainers to learn, and its session model would have required migrating the consumer apps' session handling anyway. The deciding factor was maintainer continuity, not capability.
- **OpenAuth (Cloudflare-native OIDC issuer)**: cleanest separation; lost because token/OIDC flows in every consumer app are strictly more moving parts than a shared cookie, for no benefit at this scale.

## Consequences

Good: consumer apps change almost nothing to integrate; the whole estate shares one mental model; Proscenium's battle-tested flows get reused. Bad: we own verification/reset/admin code a framework would have given us; nuxt-auth-utils minor versions occasionally move session config: pin and read changelogs. Revisit if the estate ever needs orgs/teams, passkeys at scale, or third-party OIDC clients.
