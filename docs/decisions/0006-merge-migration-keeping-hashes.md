# ADR-0006: One-off user merge keeping scrypt hashes

**Status:** Accepted · **Date:** 2026-08-09 · **Deciders:** Matt Adcock (ITM 26/27)

## Context

Proscenium and rooms each held a user table (overlapping populations, unique emails in both). The auth DB needed populating: big-bang merge, lazy per-login migration, or fresh start.

## Decision

A one-off scripted merge keyed on lowercased email, preserving password hashes verbatim (both apps use nuxt-auth-utils' scrypt PHC format: directly portable) and preserving ids wherever an app's FKs point at them (Proscenium ids canonical on conflict; rooms UUIDs kept for rooms-only users). Full rules and the verification gate: [../migration.md](../migration.md).

## Alternatives considered

- **Lazy migration on first login**: lower one-day risk; lost because it keeps legacy auth code paths alive in both apps for months, and the long tail (users who log in yearly, at panto) never converges.
- **Fresh start**, simplest scripts; lost because it severs `reservations`/`bookings` history from their owners and makes every ticket booker re-register, the exact population whose experience must not get worse.

## Consequences

Good: single cutover, nobody resets a password, booking history intact, legacy code deleted immediately. Bad: one high-stakes day: mitigated by mandatory rehearsal against exported copies, an asserted verification gate, `legacy_ids` insurance for every row, and an hours-not-days cutover window in a quiet week. The merge rules double as the template for migrating future apps in.
