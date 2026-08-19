# GDPR & Data Retention

The auth service's part of the theatre's data-protection obligations. **Status: built (Phase 7, 2026-08-12)** — erasure, subject-access export, and the retention sweep are live; the sweep ships in dry-run until the Archivist reviews a production report and arms it in `server/utils/retentionConfig.ts`.

Framing, honestly: software is never "GDPR compliant" by itself — compliance is mostly process (lawful basis, privacy notice, honouring requests within one month, breach handling). The NNT's full data-protection policy is a committee document (in progress, ITM + Secretary, target spring 2027); the Workspace & Data Retention Policy v1.0 covers Workspace and explicitly defers audience/ticketing data to it. **This service and the app databases are where that deferred data lives.** This doc makes the technical side ready. None of it is legal advice; SU guidance takes precedence.

## What personal data the estate holds (via this service's lens)

| Data | Where | Basis (proposed, for the policy to ratify) |
|---|---|---|
| Email, name, password hash, Google link | auth DB `users` | Contract (providing the account/booking) |
| Login/audit metadata | auth DB `last_login`, `audit_log` | Legitimate interest (security) |
| Reservations, attendance history | Proscenium DB | Contract; financial records → legal obligation (6 y) |
| Room bookings | rooms DB | Contract |
| Mirror rows (id, email, name) | each app DB | Same basis as the app's data |

Data minimisation is a design rule: no DOB, no address, no phone, no analytics identifiers in the auth DB. Adding any new personal-data column requires updating this table and, if it changes the basis, the committee policy.

## Right to erasure — anonymise, never delete

`reservations.user_id` is NOT NULL/`restrict`, and sales records carry a 6-year financial retention — so **erasure rewrites, it doesn't remove rows**. `POST /api/users/:id/erase` (admin) / `POST /api/account/erase` (self-service, password- or session-confirmed):

1. Auth `users` row → email `deleted-<id>@anonymised.invalid`, name `Deleted user`, password NULL, `google_sub` NULL, `email_verified` 0, `disabled` 1; verification/reset tokens deleted; roles deleted; second factors (passkeys, TOTP secret, recovery codes) deleted; `eligibility_snapshots` and `retention_notices` rows deleted (one records a named person's training standing, the other when we warned them — neither is a statistic that must survive).
2. For each registered app: `POST <app>/api/_hooks/auth/anonymise { userId }` — the app rewrites its mirror row identically and scrubs free-text fields that may hold personal data (Proscenium: `customer_notes`; each app documents its own scrub list in its hook implementation). Hooks are idempotent; failures are retried and surfaced to the admin — an erasure isn't "done" until every hook has succeeded. "Every" means **at least one**: an empty hook list reports incomplete rather than vacuously complete, and an app answering HTTP 200 with `{ ok: false }` is a refusal, not a success. The upstream failure message is logged and never returned in the response, since `/api/account/erase` is member-facing.
3. `session_epoch` bumped (live sessions die), action audit-logged (the audit entry references the anonymous id only).

Bookings and reservations survive as anonymous rows: attendance counts, revenue, and room-usage statistics are intact; the person is gone. Retention exception (document per request, don't build): records genuinely needed for legal claims or financial audit may be retained per the policy.

**Erasure is irreversible.** The admin UI requires typed confirmation, and [operations.md](operations.md#user-operations-admin-ui-admin) covers verifying the requester's identity first.

## Right of access

`GET /api/users/:id/export` (admin) and self-service from `/account`: a JSON bundle of the auth record (profile, roles, linked identity, `last_login`, second-factor types and enrolment dates — never the secrets themselves, relevant audit entries: rows targeting the subject carry their `detail`, rows the subject merely *acted on* are listed without it, because that `detail` describes someone else) plus each app's `export` hook contribution (their reservations, bookings, preferences). One statutory month to respond; the export takes seconds, so the clock is about identity verification, not tooling.

## Inactive-account retention sweep

A Workers cron on the auth service. **Config-driven** (`retention.config.ts` — periods live in config, not code, because committee ratifies them), **staged**, and **dry-run first**: the sweep's first production run, and any run after a config change, executes in dry-run mode producing a report the Archivist reviews before arming.

| Cohort | Trigger | Action |
|---|---|---|
| Shadow/guest accounts | No activity for **3 years** (max of app `last-activity` hooks) | Anonymise directly — the person only ever bought a ticket; there is no account relationship to warn about |
| Full accounts (email+password) | No login for **2 years** | Email warning ("log in within 60 days to keep your account"), reminder at 30 days, then anonymise |
| Google-linked accounts | Workspace deletion upstream (leaving + 12 months per the Workspace policy) ends SSO; thereafter the 2-year clock applies like any account | Warn-then-anonymise |
| Accounts holding any role | **Exempt** while roles are held; handover removes roles, then normal clocks | — |

Safety property: if any app's `last-activity` hook fails, the guest cohort is skipped for that run — inactivity can't be proven without every app's answer.

All periods are proposals until ratified; record adopted values in both the config and the committee policy. Every sweep action is audit-logged; a monthly digest email goes to the Archivist (its absence is an alert — see [operations.md](operations.md#monitoring)).

Backups: exported snapshots contain pre-anonymisation data. Backup retention (8 weekly / 12 monthly, [operations.md](operations.md#backups)) is therefore the effective ceiling on erasure completeness — the policy should state that erased data persists in encrypted backups for up to 12 months. This is standard practice; write it down rather than pretending otherwise.

## Privacy notices (UI copy, not machinery)

One line + link on register and booking forms: *"We store your name and email to manage your booking — see our privacy policy."* The policy page is committee-owned content. **No consent checkboxes, no marketing flags** — the Mailchimp list is a separate, separately-consented system and stays that way.

## Breach handling (pointer)

A personal-data breach may require ICO notification within 72 hours of awareness. The technical first-responses live in [operations.md](operations.md#incidents) (rotate secret, disable, audit); the *decision* to notify is the committee's with SU advice. Put the SU contact in the estate tracker before this is ever needed.
