# Data Model

D1 database `auth`, Drizzle ORM, SQLite dialect. Schema lives in `server/db/schema/`; migrations are generated (`bun run db:generate`) then hand-reviewed — D1 is SQLite, so no `ALTER COLUMN`; column changes are table rebuilds.

IDs are `nanoid()` text primary keys (matching Proscenium's convention), except where a migrated rooms-only user kept their original UUID — both are opaque strings and nothing may parse them. **Canonical user ids are stable forever** (CLAUDE.md invariant 3).

## Tables

### `users`

| Column | Type | Notes |
|---|---|---|
| `id` | text PK | nanoid (or preserved rooms UUID). Never changes. |
| `email` | text unique, not null | Stored lowercased; lowercase on the way in, always. |
| `name` | text not null | |
| `password` | text null | scrypt PHC string (`$scrypt$…`) via nuxt-auth-utils. `NULL` = shadow account or SSO-only. |
| `email_verified` | integer (bool) not null default 0 | Set by token flow or Google sign-in. |
| `google_sub` | text unique null | Google's stable subject id. Linkage key — **not** email ([ADR-0005](decisions/0005-workspace-only-google-sso.md)). A linked Google identity may carry a different address from `email` — that's normal (personal email + later Workspace account, one person, one id). |
| `pending_google_email` | text null | Admin-set: the next Google sign-in with this (Workspace) address attaches to this account instead of creating a new one. Cleared on consumption or by the admin. |
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
| `expiry_warned_at` | integer (ms) null | One warning per (grant, expiry value); cleared when `expires_at` changes so renewals re-arm. |

No central registry of apps or roles — a namespace exists the moment a role in it is granted ([ADR-0004](decisions/0004-scoped-role-strings.md)). Known namespaces and their meanings are listed in [integrating-an-app.md](integrating-an-app.md#role-namespaces).

### `role_definitions`

Optional UX metadata driving the admin grant dropdown ([ADR-0011](decisions/0011-role-definitions-and-expiry.md)): `namespace` + `role` (unique pair), `description`, `default_expiry_kind` (`none` | `committee-year` | `days`) + `default_expiry_days`. A grant never requires a definition; deleting one never touches grants. The committee year end (31 July) lives in `server/utils/rolesConfig.ts`.

### `email_verifications` / `password_resets` / `magic_links`

All three: `user_id` (FK cascade), a unique token column, `expires_at`. Tokens are `randomBytes(32)` hex, **stored as their SHA-256 (ADR-0013)** — the plaintext exists only in the email. Verification tokens live 24 h; reset tokens 1 h (self-service) or 24 h (admin-initiated); magic links 15 minutes. All single-use; issuing a new reset or magic link deletes outstanding ones for that user. Expired magic links are also swept nightly.

### `legacy_ids`

| Column | Notes |
|---|---|
| `user_id` FK cascade · `source` (`'proscenium'` \| `'rooms'`) · `legacy_id` text | Unique on `(source, legacy_id)`. Written for **every** migrated user, even where ids were preserved. Read-only after migration; keep forever (it is tiny and it answers "who was rooms user X?"). |

### `service_tokens`

| Column | Notes |
|---|---|
| `id` · `name` (e.g. `proscenium`) · `token_hash` (SHA-256 of the bearer token) · `created_at` · `last_used_at` | Plaintext token shown once at creation (`nnt_svc_` prefix + 32 random bytes, base64url). Compare in constant time. Issue/rotate via [operations.md](operations.md#service-tokens). |

### `audit_log`

| Column | Notes |
|---|---|
| `id` · `actor_user_id` (null = system/cron) · `action` text · `target` text · `detail` text (JSON) · `created_at` | Append-only. Written by: all admin UI actions, role grants/revokes, force-logouts, account disable, erasure/anonymisation, retention sweep actions, service-token issuance. Not written by: ordinary logins (that's `last_login`). |

### `retention_notices`

Warning-email bookkeeping for the retention sweep: `user_id` (FK cascade), `stage` (`warning-60d` | `warning-30d`, unique per user), `sent_at`. Rows are cleared when the user logs in again (their clock resets) and cascade away on erasure.

### MFA tables (ADR-0012)

Four small tables, all `user_id` FK cascade:

| Table | Notes |
|---|---|
| `webauthn_credentials` | Passkeys: `credential_id` (unique), `public_key`, `counter`, `transports` (JSON), `backed_up`, `name` (user's device label), `created_at`, `last_used_at`. Shape mirrors the `WebAuthnCredential` nuxt-auth-utils hands to `onSuccess`, so registration is a straight insert |
| `totp_secrets` | One row per user (`user_id` is the PK): `secret` (base32), `confirmed_at` (null = enrolment started but never proved, which never gates a login), `last_used_step` (replay guard — a code is valid for its whole window, so the accepted step is remembered and never re-accepted) |
| `mfa_recovery_codes` | `code_hash` (SHA-256 hex, like service tokens — plaintext shown once and never stored), `used_at`. Eight per user, replaced wholesale on regeneration |
| `mfa_challenges` | Short-lived server state doing two jobs: WebAuthn challenges (`kind` = `webauthn-register` / `webauthn-authenticate`, with `challenge`) and pending logins (`kind` = `login`, password accepted but factor outstanding). `user_id` is nullable — a passkey *authentication* challenge is usernameless, so there is no account to attribute it to when it's issued. Single-use on read, and swept by the nightly `rate-limits:sweep` task |

Erasure clears all four (`clearAllFactors`); the subject-access export lists factor types and dates but never a secret, a public key, or a code.

### `rate_limits`

Fixed-window counters: `key` (`<scope>:<subject>`, e.g. `login:ip:1.2.3.4`, `login:acct:<email>`), `window_start`, `count`. One row per key, window reset in place by an atomic upsert; swept nightly by the `rate-limits:sweep` task. Chosen over Cloudflare WAF rules at build time — [ADR-0009](decisions/0009-d1-backed-rate-limiting.md). Limits live in `RATE_LIMITS` in `server/utils/rateLimit.ts`.

## Relationship to app databases

Consumer apps keep **thin mirrors** — `users(id, email, name)` plus app-specific columns (rooms keeps its notification-preference columns) — upserted from the session. Their FKs (Proscenium `reservations.user_id` NOT NULL/`restrict`; rooms `bookings.user_id` nullable/`SetNull`) point at mirror rows whose ids equal canonical ids. The auth service never reaches into app databases; cross-cutting operations (export, anonymise, last-activity) go through the [app hooks](integrating-an-app.md#hooks).

## Schema-change checklist

1. Edit `server/db/schema/*`, run `bun run db:generate`, **read the generated SQL** (SQLite table rebuilds can drop data if careless).
2. Update this doc's table(s) in the same PR.
3. If the change affects the session payload → [session-contract.md](session-contract.md) version bump + ADR if breaking.
4. Migration applied to production via `wrangler d1 migrations apply` during a quiet window — see [operations.md](operations.md#deployments).
