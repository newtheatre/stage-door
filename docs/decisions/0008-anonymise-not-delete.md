# ADR-0008: Erasure = anonymisation, not deletion

**Status:** Accepted · **Date:** 2026-08-09 · **Deciders:** Matt Adcock (ITM 26/27)

## Context

GDPR erasure requests and the retention sweep both need to remove people. But `reservations.user_id` is NOT NULL/`restrict`, financial records carry ~6-year retention expectations, and attendance/room-usage statistics are part of the theatre's operational and historical record.

## Decision

"Erasing" a user rewrites rather than removes: the auth row becomes `deleted-<id>@anonymised.invalid` / "Deleted user" with all credentials, links, roles, and tokens cleared and the account disabled; each app's `anonymise` hook rewrites its mirror row and scrubs free-text personal data. Booking/reservation rows survive anonymised. Full procedure: [../gdpr-retention.md](../gdpr-retention.md).

## Alternatives considered

- **Hard delete with FK cascade/relaxation** — lost: destroys sales and attendance statistics the treasurer and archivist legitimately need, and requires weakening `restrict` constraints that exist to prevent accidental loss.
- **Soft-delete flag only (keep the data, hide it)** — lost: doesn't actually erase anything, which fails the point of the request.

## Consequences

Good: statistics survive; FKs never break; the operation is a bounded rewrite, safe to automate for the retention sweep; idempotent hooks make retries safe. Bad: "erased" data persists in encrypted backups until backup retention lapses (≤12 months — documented, standard practice); anonymisation must be checked for completeness whenever a new personal-data field is added anywhere (the data-inventory table in gdpr-retention.md is the checklist). Irreversibility is enforced with typed confirmation in the admin UI.
