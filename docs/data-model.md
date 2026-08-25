# Data Model

D1 database `auth`, Drizzle ORM, SQLite dialect. Schema lives in `server/db/schema/`; migrations are generated (`bun run db:generate`) then hand-reviewed: D1 is SQLite, so no `ALTER COLUMN`; column changes are table rebuilds.

IDs are `nanoid()` text primary keys (matching Proscenium's convention), except where a migrated rooms-only user kept their original UUID: both are opaque strings and nothing may parse them. **Canonical user ids are stable forever** (CLAUDE.md invariant 3).

## Tables

### `users`

| Column | Type | Notes |
|---|---|---|
| `id` | text PK | nanoid (or preserved rooms UUID). Never changes. |
| `email` | text unique, not null | Stored lowercased; lowercase on the way in, always. |
| `name` | text not null | |
| `password` | text null | scrypt PHC string (`$scrypt$…`) via nuxt-auth-utils. `NULL` = shadow account or SSO-only. |
| `email_verified` | integer (bool) not null default 0 | Set by token flow or Google sign-in. |
| `google_sub` | text unique null | Google's stable subject id. Linkage key, **not** email ([ADR-0005](decisions/0005-workspace-only-google-sso.md)). A linked Google identity may carry a different address from `email`, that's normal (personal email + later Workspace account, one person, one id). |
| `pending_google_email` | text null unique | Admin-set: the next Google sign-in with this (Workspace) address attaches to this account instead of creating a new one. Cleared on consumption, by the admin, or when a sign-in resolves that address by `google_sub` elsewhere and the marker becomes unreachable. Unique because it outranks an address match at sign-in, so two rows carrying one address would pick an arbitrary winner; NULLs are distinct in SQLite, so unset rows are unaffected. |
| `disabled` | integer (bool) not null default 0 | Disabled users fail login and fail `/api/session/refresh`. |
| `session_epoch` | integer not null default 0 | Bump to invalidate this user's sessions at next refresh (force-logout). |
| `created_at` / `updated_at` / `last_login` | integer (ms) | `last_login` updated on successful login/SSO only, not refresh. |

Derived: `guest` (session field) = `password IS NULL AND google_sub IS NULL`.

### `user_roles`

| Column | Type | Notes |
|---|---|---|
| `user_id` | text FK → users.id, cascade | |
| `role` | text not null | Scoped string `app:ROLE`, e.g. `proscenium:BOX_OFFICE`, `rooms:ADMIN`, `auth:ADMIN`. Unique on `(user_id, role)`. |
| `expires_at` | integer (ms) null | NULL = permanent. **Enforced at read time** ([ADR-0011](decisions/0011-role-definitions-and-expiry.md)): `loadRoles`/`activeRoleCondition` filter expired grants out of every session seal, the admin guard, the retention-sweep exemption, and the admin role filter. Any new raw query against this table must apply the same predicate. |
| `granted_by` / `granted_at` / `note` | text / integer / text, all null | Grant provenance. NULL = pre-v2 grant. |
| `expiry_warned_at` | integer (ms) null | One warning per (grant, expiry value); cleared when `expires_at` changes so renewals re-arm. Written only for holders the task actually reached, so a failed send is retried tomorrow rather than skipped. |

No central registry of apps or roles: a namespace exists the moment a role in it is granted ([ADR-0004](decisions/0004-scoped-role-strings.md)). Known namespaces and their meanings are listed in [integrating-an-app.md](integrating-an-app.md#role-namespaces).

### `role_definitions`

What a role is: `namespace` + `role` (unique pair), `description`, `default_expiry_kind` (`none` | `committee-year` | `days`) + `default_expiry_days`. A **new** grant requires a definition ([ADR-0014](decisions/0014-grants-require-definitions.md)); roles a person already holds are exempt, and deleting a definition still never touches grants ([ADR-0011](decisions/0011-role-definitions-and-expiry.md)). The committee year end (31 July) lives in `server/utils/rolesConfig.ts`.

Most rows now come from their app's manifest ([ADR-0018](decisions/0018-manifest-declared-roles.md)) rather than being typed in:

| Column | Notes |
|---|---|
| `app_id` · `source` · `manifest_version` · `synced_at` | `source` is `manifest` or `manual`. Every live definition is `manifest`, including this service's own `auth:*` roles ([ADR-0024](decisions/0024-role-definitions-come-only-from-manifests.md)). `manual` is frozen history only: the dormant `ticketing:*` namespace, which has no app behind it. No code path creates one. |
| `withdrawn_at` | Set when the owning manifest stops declaring the role. **Grants are untouched and the row is never deleted.** It leaves the grant picker and shows struck through with its holder count. Re-declaring clears it. |
| `requires_eligibility_key` · `eligibility_mode` | A training prerequisite (`advisory` or `enforcing`), named by the app and enforced at this service's discretion ([ADR-0019](decisions/0019-training-conditional-grants.md)). |
| `role_key` | **Generated, virtual**: `namespace \|\| ':' \|\| role`. The joined form `user_roles.role` stores, so a grant can be matched to its definition inside SQL rather than by concatenating in JavaScript. Indexed. |

### `email_verifications` / `password_resets` / `magic_links`

All three: `user_id` (FK cascade), a unique token column, `expires_at`. Tokens are `randomBytes(32)` hex, **stored as their SHA-256 (ADR-0013)**: the plaintext exists only in the email. Verification tokens live 24 h; reset tokens 1 h (self-service) or 24 h (admin-initiated); magic links 15 minutes. All single-use; issuing a new verification, reset or magic link deletes outstanding ones for that user. Expired magic links are also swept nightly.

`email_verifications` additionally carries `email`, the address the link was mailed to. Redemption compares it against `users.email` and refuses on any difference, so an outstanding token cannot verify an address the account was re-pointed at afterwards. The column is nullable only because rows minted before it existed could not be backfilled honestly; `0016_clear_unbound_verifications` deleted them, and any that reappear verify nothing.

### `legacy_ids`

| Column | Notes |
|---|---|
| `user_id` FK cascade · `source` (`'proscenium'` \| `'rooms'` \| `'merge'`) · `legacy_id` text | Unique on `(source, legacy_id)`. Written for **every** migrated user, even where ids were preserved. `'merge'` rows are markers, not imports: `legacy_id` holds the erased account's `users.id`, so a merged-away identity is always traceable to its winner (ADR-0015). Read-only after migration; keep forever (it is tiny and it answers "who was rooms user X?"). |

### `apps` (ADR-0017)

The estate's app registry. A row is what makes an app real to this service: hooks reach it, and adding one needs no deploy here.

| Column | Notes |
|---|---|
| `id` | nanoid |
| `name` | Unique. The app's short name, e.g. `rehearsal`. Joins `service_tokens.name`, which is how `hookBearer` finds the token. |
| `namespace` | Unique. The app's **role** namespace, e.g. `training`. Deliberately separate from `name`: `rehearsal` serves `training`. |
| `display_name` · `base_url` | `base_url` has no trailing slash; https, or `http://localhost:PORT` for local development. Hooks post to `<base_url>/api/_hooks/auth/<hook>`. |
| `hooks_enabled` | Defaults to **off**. `callAllAppHooks` fans out over enabled rows only, so a half-registered app cannot silently swallow an erasure. |
| `created_at` | |

| `manifest_enabled` | Defaults to **off**. The first sync of an app is done by an admin watching the result, because adoption rewrites a hand-made definition's description and expiry (ADR-0018). |
| `last_synced_at` | Last successful manifest reconcile. Stale means an app's ping stopped working. |

Managed at `/admin/apps`. `name` and `namespace` are immutable after creation; grants and tokens join on them.

### `app_manifests` (ADR-0018)

One row per app: the last manifest it served. **A failed fetch or a rejected document writes only `last_attempt_at` and `last_error`**: `document` is never overwritten by a failure, which is what makes "an unreachable app withdraws nothing" true.

| Column | Notes |
|---|---|
| `app_id` (PK) · `document` · `document_hash` | `document_hash` is the SHA-256 of the raw body. Equal means reconciliation is skipped entirely. |
| `version` · `etag` | `version` is free text from the manifest, echoed in the admin UI, never parsed or ordered. `etag` drives `If-None-Match`. |
| `fetched_at` · `applied_at` · `last_attempt_at` · `last_error` | `applied_at` is the last reconcile; `last_attempt_at` moves on every try, success or not. Non-null `last_error` means the stored document is stale but still in force. |

### `eligibility_snapshots` and `eligibility_syncs` (ADR-0019)

Who currently satisfies each of rehearsal's eligibility rules. **Presence means eligible**: only the qualifying set is stored, so the `loadRoles` predicate is a bare `not exists`.

| Table | Notes |
|---|---|
| `eligibility_snapshots(rule_key, user_id, captured_at)` | PK on `(rule_key, user_id)`. Replaced per rule by **upserting the new membership, then pruning rows older than this run's stamp**, so the snapshot is never briefly empty and a failure part-way leaves the old answer in force. The stamp is forced strictly newer than every row already present, so two syncs inside one millisecond still prune exactly. The insert is chunked at 30 rows (3 bound parameters each = 90; D1 caps at 100). |
| `eligibility_syncs(rule_key, last_attempt_at, last_success_at, user_count, last_error)` | Separate so it survives the snapshot being replaced. **A null `last_success_at` means never answered, which is what stops enforcement engaging on an unconfirmed rule.** A failed sync stamps `last_attempt_at` and `last_error` and leaves `last_success_at` alone, so the old answer stays in force. rehearsal's answer is Zod-parsed, so a malformed 200 is a failure rather than an empty set, and an answer naming no holders at all is refused rather than applied, because emptying a live snapshot revokes the role for every holder estate-wide. |

Populated by the `eligibility:snapshot` task on the 04:00 cron, and never on a request path. `user_roles.eligibility_override_until` lifts an enforcing prerequisite for one grant, capped at 90 days and audited.

### `app_permissions` and `role_definition_permissions` (ADR-0018)

The permission vocabulary an app declares, and which role definition carries which. Permission keys are lowercase and dotted (`money.refund`) where roles are uppercase (`BOX_OFFICE`), so no string can be read as both.

`app_permissions` is unique on `(namespace, key)`. A permission the manifest stops declaring is set `active = false`, **never deleted**: role links and audit detail reference the row. The index on `role_definition_permissions.permission_id` is what answers "who can approve refunds?" in one join.

### `service_tokens`

| Column | Notes |
|---|---|
| `id` · `name` (e.g. `proscenium`) · `token_hash` (SHA-256 of the bearer token) · `created_at` · `last_used_at` | Plaintext token shown once at creation (`nnt_svc_` prefix + 32 random bytes, base64url). Compare in constant time. Issue/rotate via [operations.md](operations.md#service-tokens). `name` is **not unique**: overlap rotation means an app briefly holds two, `requireServiceToken` accepts either, and `hookBearer` sends the newest by `created_at`. Every outbound call goes through `hookBearer`, the manifest fetch included, so one rule decides which token leaves. |
| `app_id` | Nullable link to `apps.id`, for queryability and reporting only. **The `name` join is the authority** everywhere it matters: `hookBearer`, `GET /api/role-holders` (which resolves the caller's namespace from it) and the revoke in `DELETE /api/apps/:id`. A missed backfill therefore breaks nothing. `createServiceToken` fills it in when an app of that name is already registered, and leaves it null when one is not, because an app may be integrated before it reaches the registry. No `ON DELETE` clause: SQLite cannot add one to an existing table, so `DELETE /api/apps/:id` deletes the app's tokens **by name** before removing the row. Orphaning them would leave a credential that still authenticates, because `requireServiceToken` never consults `app_id`. |

### `audit_log`

| Column | Notes |
|---|---|
| `id` · `actor_user_id` (null = system/cron) · `action` text · `target` text · `detail` text (JSON) · `created_at` | Append-only, with **one exception**: erasure rewrites `detail` on rows whose `target` is the erased user, replacing addresses and names with `[redacted]` and leaving `action`, `target`, `actor_user_id` and `created_at` alone ([ADR-0026](decisions/0026-erasure-redacts-the-audit-log.md)). Nothing else updates or deletes a row. `detail` must never carry an address or a name: the id in `target` says who, and a value here would outlive an erasure. Written by: all admin UI actions, role grants/revokes, force-logouts, account disable, erasure/anonymisation, retention sweep actions, service-token issuance. Not written by: ordinary logins (that's `last_login`). Indexed on `target`, `actor_user_id`, `action` and `created_at`: the table grows without bound, and "everything that happened to this user" is `?target=` |

### `retention_notices`

Warning-email bookkeeping for the retention sweep: `user_id` (FK cascade), `stage` (`warning-60d` | `warning-30d`, unique per user), `sent_at`. Rows are cleared when the user logs in again (their clock resets), and are deleted outright on erasure along with `eligibility_snapshots`.

### MFA tables (ADR-0012)

Four small tables, all `user_id` FK cascade:

| Table | Notes |
|---|---|
| `webauthn_credentials` | Passkeys: `credential_id` (unique), `public_key`, `counter`, `transports` (JSON), `backed_up`, `name` (user's device label), `created_at`, `last_used_at`. Shape mirrors the `WebAuthnCredential` nuxt-auth-utils hands to `onSuccess`, so registration is a straight insert |
| `totp_secrets` | One row per user (`user_id` is the PK): `secret` (base32), `confirmed_at` (null = enrolment started but never proved, which never gates a login), `last_used_step` (replay guard: a code is valid for its whole window, so the accepted step is remembered and never re-accepted) |
| `mfa_recovery_codes` | `code_hash` (SHA-256 hex, like service tokens: plaintext shown once and never stored), `used_at`. Eight per user, replaced wholesale on regeneration |
| `mfa_challenges` | Short-lived server state doing two jobs: WebAuthn challenges (`kind` = `webauthn-register` / `webauthn-authenticate`, with `challenge`) and pending logins (`kind` = `login`, password accepted but factor outstanding). `user_id` is nullable: a passkey *authentication* challenge is usernameless, so there is no account to attribute it to when it's issued. Single-use on read, and swept by the nightly `rate-limits:sweep` task |

Erasure clears all four (`clearAllFactors`); the subject-access export lists factor types and dates but never a secret, a public key, or a code.

### `rate_limits`

Fixed-window counters: `key` (`<scope>:<subject>`, e.g. `login:ip:1.2.3.4`, `login:acct:<email>`), `window_start`, `count`. One row per key, window reset in place by an atomic upsert; swept nightly by the `rate-limits:sweep` task. Chosen over Cloudflare WAF rules at build time: [ADR-0009](decisions/0009-d1-backed-rate-limiting.md). Limits live in `RATE_LIMITS` in `server/utils/rateLimit.ts`.

## Relationship to app databases

Consumer apps keep **thin mirrors**, `users(id, email, name)` plus app-specific columns (rooms keeps its notification-preference columns), upserted from the session. Their FKs (Proscenium `reservations.user_id` NOT NULL/`restrict`; rooms `bookings.user_id` nullable/`SetNull`) point at mirror rows whose ids equal canonical ids. The auth service never reaches into app databases; cross-cutting operations (export, anonymise, last-activity) go through the [app hooks](integrating-an-app.md#hooks).

## Schema-change checklist

1. Edit `server/db/schema/*`, run `bun run db:generate`, **read the generated SQL** (SQLite table rebuilds can drop data if careless).
2. Update this doc's table(s) in the same PR.
3. If the change affects the session payload → [session-contract.md](session-contract.md) version bump + ADR if breaking.
4. Migration applied to production via `wrangler d1 migrations apply` during a quiet window: see [operations.md](operations.md#deployments).
