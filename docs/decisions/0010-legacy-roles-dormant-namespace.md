# ADR-0010: Legacy-import roles land in a dormant `ticketing:*` namespace

**Status:** Accepted · **Date:** 2026-08-11 · **Deciders:** Claude Code during the live migration, ratified by Matt Adcock (ITM 26/27) at cutover

## Context

The legacy ticketing site's data was imported into Proscenium's tables hours before the account migration ran. The importer mapped the old site's `foh`/`manager`/`admin` role holders onto Proscenium's live `ADMIN`/`MANAGER`/`BOX_OFFICE` enum — including alumni, role accounts, and a placeholder (`izzy@legacy.invalid`). Migrating those rows verbatim would have granted **live Proscenium admin/box-office powers** to ~8 accounts nobody had vetted for them, several with passwords resettable by whoever controls old personal mailboxes.

## Decision

Role rows held by users the legacy import created map to `ticketing:ADMIN|MANAGER|BOX_OFFICE` — a namespace no deployed app reads, so the roles grant nothing anywhere. Users that existed before the import keep live `proscenium:*` roles. The discriminator is the pre-import id set (622 ids, captured from the pre-import migration build). Individuals who should hold live roles get them explicitly via the auth admin UI (the ITM's own account did, at migration).

## Alternatives considered

- **Carry roles verbatim into `proscenium:*`** — rejected: a silent privilege grant to unvetted accounts is precisely the failure mode a central role store exists to prevent.
- **Drop the legacy roles entirely** — rejected: the information ("this person ran the old box office") is real and cheap to keep; when ticketing rebuilds on this stack (plan §11 already earmarked a `ticketing:*` namespace for it), it is the natural starting role set.

## Consequences

Good: no privilege escalation at migration; one-minute per-person upgrades in the admin UI; the future ticketing app inherits a meaningful role set. Bad: the namespace table needs a "dormant" caveat (done, integrating-an-app.md) so nobody mistakes the roles for live ones; anyone auditing "who can do what" must know `ticketing:*` currently means "historical fact, not capability".
