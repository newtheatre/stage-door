# ADR-0004: Roles as scoped strings; authorisation stays in apps

**Status:** Accepted · Partially superseded by [ADR-0011](0011-role-definitions-and-expiry.md) (grant expiry + optional definitions; scoped strings and no-mandatory-registry survive) · **Date:** 2026-08-09 · **Deciders:** Matt Adcock (ITM 26/27)

## Context

Proscenium had a three-role enum and a well-factored ability layer (`nuxt-authorization`); rooms had a two-role enum with inline checks. Central identity raises the question: does authorisation centralise too?

## Decision

The auth service stores and distributes **roles only**, as flat scoped strings (`proscenium:BOX_OFFICE`, `rooms:ADMIN`, `auth:ADMIN`) in `user_roles` and in the session. What a role *means*, the permission logic, stays entirely in each app (Proscenium keeps its ability layer; rooms keeps `requireAdmin`). No central permissions, no role hierarchy, no app registry: a namespace exists when its first role is granted.

## Alternatives considered

- **Central permission service (policy checks via API)**: lost instantly: puts the auth service on every request path and centralises the one thing each app understands best about itself.
- **Structured role tables (app registry + role registry + assignments)**: tidier in theory; lost because it adds schema and admin ceremony for an estate of three apps whose role lists change roughly never. Strings with a validated format (`app:ROLE`) carry the same information.
- **Per-app role storage (status quo)**: lost because "what can this person do, everywhere?" then requires querying every app, and handover/offboarding role sweeps stay manual and forgettable.

## Consequences

Good: one screen shows a person's full access; granting `photos:UPLOADER` next year needs zero code; apps' authorisation code barely changes (read the namespace, keep the logic). Bad: no validation that a granted role is one the app actually checks (typo risk: mitigated by the documented namespace table in integrating-an-app.md and the format regex); roles ride in the cookie, so ADR-0003's staleness rules apply to them.
