# ADR-0011: Role definitions and grant expiry

**Status:** Accepted · **Date:** 2026-08-12 · **Deciders:** Matt Adcock (ITM 26/27), implemented with Claude Code · Partially supersedes [ADR-0004](0004-scoped-role-strings.md)

## Context

v1 roles were free-text scoped strings granted indefinitely (ADR-0004). Two gaps: granting meant typing a string with only a regex against typos, and nothing ever expired — which is the committee-handover problem in disguise. Nearly every NNT role is held for a committee year, and revoking them all at handover was a manual checklist step that history says gets missed.

## Decision

Two additions, neither touching the session contract (roles remain `string[]` — expiry is a property of the *grant*, not the session):

1. **Per-grant expiry, enforced at read time.** `user_roles` gains `expires_at` (NULL = permanent), plus provenance (`granted_by`, `granted_at`, `note`) and warning bookkeeping (`expiry_warned_at`). `loadRoles` — the single funnel every session seal and the admin guard pass through — filters to active grants. An expired role therefore vanishes from privileged surfaces within the existing 15-minute staleness window; on the auth service's own admin surface it vanishes on the next request. No cron is needed for correctness; a daily task warns holders 14 days out (one warning per (grant, expiry value) — changing an expiry clears the flag, so renewals re-arm) and cosmetically deletes rows expired more than 90 days.
2. **An optional `role_definitions` table** (namespace, role, description, default expiry: none / end-of-committee-year / fixed days) drives the admin UI: granting becomes pick-from-dropdown with the expiry pre-filled from the definition's default. The committee year end (31 July, `rolesConfig.ts`) powers the end-of-committee-year default — a role granted in October lapses the following 31 July, and handover stops depending on anyone remembering.

What survives from ADR-0004: scoped strings everywhere (sessions, checks, app code — consumer apps needed zero changes), and **no mandatory registry** — free-text granting stays behind an "advanced" toggle, so a namespace can still exist before its definitions do, and deleting a definition never touches grants.

Existing production grants were left permanent at migration (confirmed decision) — expiry arrives on re-grant. The dormant `ticketing:*` roles (ADR-0010) get neither definitions nor bulk expiry: they are historical facts that grant nothing, not live capabilities.

## Alternatives considered

- **Enforcement cron (delete expired rows on schedule)** — rejected: read-time filtering is simpler, atomic with sealing, and the refresh mechanism already bounds staleness at 15 minutes; deletion also destroys the renewal affordance (an expired grant you can still see is one click to renew).
- **Mandatory role registry (grants must reference a definition)** — rejected: adds ceremony ADR-0004 deliberately avoided, and breaks "a namespace exists the moment a role in it is granted".
- **Expiry carried in the session** — rejected: apps would each have to re-implement expiry checks; keeping the contract at `string[]` means expiry semantics live in exactly one place.

## Consequences

Good: typo-free granting; handover shrinks to "review permanent grants"; renewal is editing a date; provenance (`granted_by/at`, notes) exists for audit and subject-access export (expired grants stay in the bundle — they're personal data). Bad: pre-v2 grants have NULL provenance forever; the admin list's role filter and the retention sweep's exemption needed the same active-grant predicate as `loadRoles` — any future raw query against `user_roles` must remember it (`activeRoleCondition` is the shared helper).
