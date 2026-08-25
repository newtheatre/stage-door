# GDPR & Data Retention

The auth service's part of the theatre's data-protection obligations. **Status: built (Phase 7, 2026-08-12)**: erasure, subject-access export, and the retention sweep are live; the sweep ships in dry-run until the Archivist reviews a production report and arms it in `server/utils/retentionConfig.ts`. An erasure whose app hook failed is re-driven on the next run (`retention-redrive`) **whether the sweep is armed or not**: finishing an erasure the member already asked for, and that this service already committed locally, is not a retention decision, and the planner will never select an already-anonymised row again. The digest reports `outstandingErasures` (the backlog the run started with) and `incompleteErasures` (what it still could not finish).

Framing, honestly: software is never "GDPR compliant" by itself: compliance is mostly process (lawful basis, privacy notice, honouring requests within one month, breach handling). The NNT's full data-protection policy is a committee document (in progress, ITM + Secretary, target spring 2027); the Workspace & Data Retention Policy v1.0 covers Workspace and explicitly defers audience/ticketing data to it. **This service and the app databases are where that deferred data lives.** This doc makes the technical side ready. None of it is legal advice; SU guidance takes precedence.

## What personal data the estate holds (via this service's lens)

| Data | Where | Basis (proposed, for the policy to ratify) |
|---|---|---|
| Email, name, password hash, Google link | auth DB `users` | Contract (providing the account/booking) |
| Login/audit metadata | auth DB `last_login`, `audit_log` | Legitimate interest (security) |
| Reservations, attendance history | Proscenium DB | Contract; financial records → legal obligation (6 y) |
| Room bookings | rooms DB | Contract |
| Mirror rows (id, email, name) | each app DB | Same basis as the app's data |
| Access needs (nine Access Card symbols) | Proscenium DB `access_profiles` | **Special category, Article 9.** Explicit consent, Article 9(2)(a), timestamped when the profile is created |
| Backstage messages (free text) | Proscenium DB | Legitimate interest (running the show). Preset transitions are performance history, free text is not |

Data minimisation is a design rule: no DOB, no address, no phone, no analytics identifiers in the auth DB. Adding any new personal-data column requires updating this table and, if it changes the basis, the committee policy.

## Right to erasure: anonymise, never delete

`reservations.user_id` is NOT NULL/`restrict`, and sales records carry a 6-year financial retention, so **erasure rewrites, it doesn't remove rows**. `POST /api/users/:id/erase` (admin) / `POST /api/account/erase` (self-service, requiring a login in the last 10 minutes and, where the account holds a password, that password):

1. Auth `users` row → email `deleted-<id>@anonymised.invalid`, name `Deleted user`, password NULL, `google_sub` NULL, `email_verified` 0, `disabled` 1; verification/reset tokens deleted; roles deleted; second factors (passkeys, TOTP secret, recovery codes) deleted; `eligibility_snapshots` and `retention_notices` rows deleted (one records a named person's training standing, the other when we warned them: neither is a statistic that must survive). **All of it in one `db.batch`**, which D1 wraps in a transaction: the anonymised address is both the first write and the marker a retry reads, so a half-applied scrub would report itself finished and leave the credentials behind for good.
2. For each registered app: `POST <app>/api/_hooks/auth/anonymise { userId }`, the app rewrites its mirror row identically and scrubs free-text fields that may hold personal data (Proscenium: `customer_notes`; each app documents its own scrub list in its hook implementation). Hooks are idempotent; failures are retried and surfaced to the admin, an erasure isn't "done" until every hook has succeeded. "Every" means **at least one**: an empty hook list reports incomplete rather than vacuously complete, and an app answering HTTP 200 with `{ ok: false }` is a refusal, not a success. The upstream failure message is logged and never returned in the response, since `/api/account/erase` is member-facing.
3. `session_epoch` bumped (live sessions die), action audit-logged (the audit entry references the anonymous id only), and every existing `audit_log` row about the person has the addresses and names in its `detail` rewritten to `[redacted]` ([ADR-0026](decisions/0026-erasure-redacts-the-audit-log.md)). `action`, `target`, `actor_user_id` and `created_at` are untouched, so the trail of what happened survives; without this the subject-access export would hand the erased person's own address straight back.

Bookings and reservations survive as anonymous rows: attendance counts, revenue, and room-usage statistics are intact; the person is gone. Retention exception (document per request, don't build): records genuinely needed for legal claims or financial audit may be retained per the policy.

### Two exceptions, both deliberate

**Access profiles are deleted, not anonymised.** Special category data under Article 9 is held on
explicit consent, and consent withdrawn has to mean the data is gone, not rewritten. An anonymised
access profile would still say somebody in that performance needed a particular provision, which is
the thing the person asked us to stop holding. Proscenium's
[ADR-0022](https://github.com/newtheatre/proscenium/blob/main/docs/decisions/0022-access-needs-are-special-category-data.md)
sets out the reasoning. Read this as an exception that was argued for, not as an oversight in an
app that forgot the anonymise rule.

Withdrawal is unconditional and immediate, at the person's request, with nothing asked in return.
Profiles also expire on their own: card expiry where there is a card, otherwise three years to match
the Access Card's own cycle, and expired or withdrawn profiles are swept on the guest-account cycle.

**Backstage free text is deleted after 30 days.** The comms board records both preset transitions
(clearance, house open, show start, interval, end) and whatever anyone typed. The presets are the
theatre's curtain-up record and are kept as performance history. The free text is chatter: 30 days
is long enough to settle who called clearance, and then it goes.

**Erasure is irreversible**, and the code enforces it: `assertNotAnonymised` refuses `PUT /api/users/:id`, `PUT /api/users/:id/roles`, `PUT /api/users/:id/pending-google`, `POST /api/users/:id/eligibility-override`, `POST /api/users/:id/enable` and `POST /api/users/:id/reset-password` on an erased row, so its identity cannot be written back while every app's mirror row stays scrubbed. The admin UI requires typed confirmation, and [operations.md](operations.md#user-operations-admin-ui-admin) covers verifying the requester's identity first.

## Right of access

`GET /api/users/:id/export` (admin) and self-service from `/account`: a JSON bundle of the auth record (profile, roles, linked identity, `last_login`, second-factor types and enrolment dates: never the secrets themselves, relevant audit entries: rows targeting the subject carry their `detail`, rows the subject merely *acted on* are listed without it, because that `detail` describes someone else) plus each app's `export` hook contribution (their reservations, bookings, preferences). On an already-erased account the bundle is still available, and carries no address: erasure redacted them ([ADR-0026](decisions/0026-erasure-redacts-the-audit-log.md)). Both routes write a `user.exported` audit row. One statutory month to respond; the export takes seconds, so the clock is about identity verification, not tooling.

## Inactive-account retention sweep

A Workers cron on the auth service. **Config-driven** (`retention.config.ts`: periods live in config, not code, because committee ratifies them), **staged**, and **dry-run first**: the sweep's first production run, and any run after a config change, executes in dry-run mode producing a report the Archivist reviews before arming.

| Cohort | Trigger | Action |
|---|---|---|
| Shadow/guest accounts | No activity for **3 years** (max of app `last-activity` hooks) | Anonymise directly: the person only ever bought a ticket; there is no account relationship to warn about |
| Full accounts (email+password) | No login for **2 years** | Email warning ("log in within 60 days to keep your account"), reminder at 30 days, then anonymise |
| Google-linked accounts | Workspace deletion upstream (leaving + 12 months per the Workspace policy) ends SSO; thereafter the 2-year clock applies like any account | Warn-then-anonymise |
| Accounts holding any role | **Exempt** while roles are held; handover removes roles, then normal clocks |: |

Safety property: **every registered app must answer** the `last-activity` hook, or the guest cohort is skipped for that run. Inactivity cannot be proven without every app's answer, and that includes an app whose `hooks_enabled` is off and an empty registry: an `every()` over no answers is vacuously true, which would read as "nobody has been active anywhere" and anonymise the lot. The digest's `guestSignalsOk` is what says whether the run could decide. This service's own registry row is not expected to answer.

Warnings are paced at `maxWarningsPerRun` per run, because Resend rate-limits and one serial send per dormant account would exhaust the worker's subrequest budget on the first armed run; the rest wait for the next night, and the digest reports `deferredWarnings`. A send that fails is counted in `sendFailures` and does **not** write a `retention_notices` row, so the account is warned again next run rather than advancing towards anonymisation unwarned; one bad recipient never aborts the run. A disabled account, or one on an undeliverable address, is marked warned without a send: nothing could arrive, and the clock has to keep running or the account is never anonymised.

All periods are proposals until ratified; record adopted values in both the config and the committee policy. Every sweep action is audit-logged; a monthly digest email goes to the Archivist (its absence is an alert: see [operations.md](operations.md#monitoring)).

Backups: exported snapshots contain pre-anonymisation data. Backup retention (8 weekly / 12 monthly, [operations.md](operations.md#backups)) is therefore the effective ceiling on erasure completeness: the policy should state that erased data persists in encrypted backups for up to 12 months. This is standard practice; write it down rather than pretending otherwise.

## Privacy notices (UI copy, not machinery)

One line + link on register and booking forms: *"We store your name and email to manage your booking, see our privacy policy."* The policy page is committee-owned content. **No consent checkboxes, no marketing flags**, the Mailchimp list is a separate, separately-consented system and stays that way.

## Breach handling (pointer)

A personal-data breach may require ICO notification within 72 hours of awareness. The technical first-responses live in [operations.md](operations.md#incidents) (rotate secret, disable, audit); the *decision* to notify is the committee's with SU advice. Put the SU contact in the estate tracker before this is ever needed.
