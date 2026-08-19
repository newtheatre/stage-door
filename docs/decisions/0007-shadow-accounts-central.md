# ADR-0007: Guest/shadow accounts live in the central identity store

**Status:** Accepted · **Date:** 2026-08-09 · **Deciders:** Matt Adcock (ITM 26/27)

## Context

Proscenium's guest checkout creates password-less "shadow" user rows so `reservations.user_id` (NOT NULL, `restrict`) always has an owner. Most audience members only ever book tickets and never want an account. With identity centralised, shadow rows could stay a Proscenium-private hack or become first-class central identities.

## Decision

Shadow accounts are **central**: Proscenium (and any future booking-taking app) calls `POST /api/users/shadow {email, name}` with its service token; the auth service matches-or-creates a password-less, unverified user and returns the canonical id. The `guest` flag rides in the session contract. A shadow user who later sets a password (register/forgot-password) or signs in with Google **becomes** a full user on the same id: history intact.

## Alternatives considered

- **Keep shadows Proscenium-local**: no service dependency in checkout; lost because the same person would then exist twice (a local shadow and, later, a central account), the account-claiming story breaks, and the next booking-taking app (ticketing rebuild) reinvents the hack.
- **Relax the FK (nullable user on reservations)**: lost because anonymous reservations lose the claiming story and the box-office "find all bookings for this person" query, and Proscenium's comment explicitly chose `restrict` to prevent accidental data loss.

## Consequences

Good: one identity per human even before they know they have one; claiming is free (it's just forgot-password); the booking-confirmation email can advertise it. Bad: guest checkout depends on the auth service being up (fail-with-retry, accepted in ADR-0002); the users table contains many never-log-in rows: which is precisely what the 3-year guest retention sweep (gdpr-retention.md) exists to tidy.
