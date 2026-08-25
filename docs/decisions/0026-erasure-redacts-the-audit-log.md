# ADR-0026: Erasure redacts identifying values in the audit log

**Status:** Accepted · **Date:** 2026-08-25 · **Deciders:** Matt Adcock (ITM 26/27) · Narrows [ADR-0008](0008-anonymise-not-delete.md)

## Context

`audit_log` is declared append-only, in `server/db/schema/audit.ts` and in the data model. Nothing in the service updated or deleted a row, and that is the property that makes the table worth having: a trail that can be rewritten is not a trail.

Several audit writers put a person's address in `detail` on a row whose `target` is that person's id: `user.created` recorded `{ email }`, both email-change routes recorded `{ email: { from, to } }`, the admin-directed Google link recorded the pending address, and the self-service Google link recorded `googleEmail`. Erasure rewrites `users` and deletes the side tables and never touched `audit_log`, so an anonymised account still carried its own address in half a dozen rows.

That is not an abstract leak. `exportUser` returns `detail` verbatim for every row targeting the subject, so `GET /api/users/:id/export` on an erased account answered with `deleted-<id>@anonymised.invalid` as the account email and the person's real address a few lines below it, in a bundle an admin can pull at any time. The anonymised row was one export away from re-identification while every consumer app's mirror had been scrubbed, which is precisely the state ADR-0008 says erasure produces and this table quietly did not.

The rule was already written down. `mergeUsers` carries it verbatim: "the loser's email must not outlive the erasure in the audit log (same rule as `user.erased`)". Six writers did not follow it.

## Decision

**Erasure is the one write to `audit_log` that is not an append.** `eraseUser` calls `redactAuditDetail(userId)`, which rewrites `detail` on every row whose `target` is that user, replacing any string containing `@` and the value of any `name` key with `[redacted]`. `action`, `target`, `actor_user_id` and `created_at` are never touched, so what happened, to whom, by whom and when all survive; only the values that re-identify the person go.

Two properties the implementation has to hold, both of which the sweep depends on:

- **Idempotent.** Rewriting an already-redacted row changes nothing, and the pass runs on every `eraseUser` call rather than only on the first, because the retention sweep re-drives a stalled erasure and a redaction skipped on the retry would leave the address behind on exactly the accounts whose first attempt failed.
- **Value-based, not key-based.** A denylist of keys rots the moment a new audit writer picks a different one. Matching on the value catches an address wherever a future caller puts it.

Alongside it, the six writers stop recording the address at all: the id in `target` already identifies the account, so the address was redundant for the trail's purpose. Redaction is what fixes the rows already in the table.

## Alternatives considered

- **Leave the historic rows and only fix the writers.** Rejected: every account created, edited or Google-linked before this change keeps its address forever, and the export hands it back. The half that needs doing is the half that touches existing data.
- **Delete the rows instead of rewriting them.** Rejected: it destroys the trail of what was done to the account, which is held on a different lawful basis (legitimate interest, security) from the identifier and is the thing the table exists for.
- **Redact at read time in `exportUser` instead.** Rejected: it hides the data from one consumer while leaving it in the database for every other reader, including a future admin screen, a support query and a backup restore. Erasure has to mean the value is gone.
- **Allow-list the keys `detail` may carry.** Rejected as the primary mechanism: it would silently drop useful detail as new actions are added, and a successor debugging a missing field would have no idea why.

## Consequences

Good: an erased account is genuinely anonymised in this service, the export bundle can no longer re-identify one, and the rule `mergeUsers` states is now enforced by machinery rather than by every author remembering it.

Bad: `audit_log` is no longer append-only without qualification, and that qualification has to be stated wherever the property is claimed. A row rewritten by erasure cannot be recovered, so a mistaken erasure loses the detail as well as the account, which is consistent with erasure being irreversible but is worth knowing before running one. Backups taken before the erasure still hold the original rows, on the same footing as every other pre-erasure value ([gdpr-retention.md](../gdpr-retention.md)).

The redaction pass reads and rewrites one row per audit entry about the user, in batches. For an ordinary account that is a handful of rows; for a long-serving committee member it is more, and it runs inside an operation that already fans out to every app.
