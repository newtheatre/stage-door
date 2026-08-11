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

No central registry of apps or roles — a namespace exists the moment a role in it is granted ([ADR-0004](decisions/0004-scoped-role-strings.md)). Known namespaces and their meanings are listed in [integrating-an-app.md](integrating-an-app.md#role-namespaces).

### `email_verifications` / `password_resets`

Both: `user_id` (FK cascade), `token` (text unique — `randomBytes(32)` hex), `expires_at`. Ported semantics from Proscenium: verification tokens live 24 h; reset tokens 1 h (self-service) or 24 h (admin-initiated); single-use; issuing a new reset deletes outstanding ones for that user.

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

### `rate_limits`

Fixed-window counters: `key` (`<scope>:<subject>`, e.g. `login:ip:1.2.3.4`, `login:acct:<email>`), `window_start`, `count`. One row per key, window reset in place by an atomic upsert; swept nightly by the `rate-limits:sweep` task. Chosen over Cloudflare WAF rules at build time — [ADR-0009](decisions/0009-d1-backed-rate-limiting.md). Limits live in `RATE_LIMITS` in `server/utils/rateLimit.ts`.

## Relationship to app databases

Consumer apps keep **thin mirrors** — `users(id, email, name)` plus app-specific columns (rooms keeps its notification-preference columns) — upserted from the session. Their FKs (Proscenium `reservations.user_id` NOT NULL/`restrict`; rooms `bookings.user_id` nullable/`SetNull`) point at mirror rows whose ids equal canonical ids. The auth service never reaches into app databases; cross-cutting operations (export, anonymise, last-activity) go through the [app hooks](integrating-an-app.md#hooks).

## Schema-change checklist

1. Edit `server/db/schema/*`, run `bun run db:generate`, **read the generated SQL** (SQLite table rebuilds can drop data if careless).
2. Update this doc's table(s) in the same PR.
3. If the change affects the session payload → [session-contract.md](session-contract.md) version bump + ADR if breaking.
4. Migration applied to production via `wrangler d1 migrations apply` during a quiet window — see [operations.md](operations.md#deployments).
