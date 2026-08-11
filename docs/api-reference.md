# API Reference

Base URL: `https://auth.newtheatre.org.uk`. All bodies JSON. Errors follow Nitro's shape: `{ statusCode, statusMessage }` — no internal detail. Endpoints marked **[RL]** are rate-limited (per-IP and, where meaningful, per-account). Endpoints marked **[AUD]** write to `audit_log`.

Three auth levels:

- **Public** — no session required.
- **Session** — `nnt-session` cookie; some additionally require a role.
- **Service** — `Authorization: Bearer nnt_svc_…` (per-app token, [operations.md](operations.md#service-tokens)).

## Auth flows

### `POST /api/auth/login` — public [RL]
`{ email, password }` → seals session, updates `last_login`, returns `{ user }`. 401 `Invalid email or password` for unknown user, wrong password, **and** password-less (guest/SSO-only) accounts — indistinguishable by design. Disabled accounts: same 401.

### `POST /api/auth/register` — public [RL]
`{ email, name, password }` (policy: ≥8 chars, upper+lower+digit) → creates user (no roles), sends verification email, seals session, returns `{ ok: true }`. If the email already belongs to a **shadow** account, this *claims* it in place (sets password, keeps id and history). If it belongs to a full account: the same `{ ok: true }` response (enumeration-safe — the body never differs), but nothing is changed, no session is sealed, and a "you already have an account" email is sent instead. *(Amended at build time: the original spec said success returns `{ user }`, which would have made the existing-account response distinguishable; a uniform body resolves the contradiction in favour of enumeration safety. The client reads login state from the session after the call.)*

### `POST /api/auth/logout` — public (idempotent)
Clears the session cookie (domain-wide), returns `{ ok: true }` whether or not a session existed. Apps POST here; they never clear the cookie themselves. Browser-facing variant: `POST /logout?redirect=<url>` clears and 302s to the validated target.

### `GET /auth/google` — public (browser redirect flow)
Google OAuth via `defineOAuthGoogleEventHandler`. The redirect target rides the round-trip in the OAuth `state` query param (`/auth/google?state=<url>`, validated against the allowlist on return — the login page builds this link). Success handler asserts `hd === 'newtheatre.org.uk'` and `email_verified === true` server-side; on failure 302s to the "not an NNT Google account" page (no session). Disabled accounts get the same rejection page. Match precedence: existing `google_sub` → account with matching `pending_google_email` (attach + clear it, audit-logged) → lowercased email match (including shadow accounts — claiming them; sets `email_verified` since Google verified that exact address) → create a new verified user. The Google address is **not** written to `users.email` when attaching to an existing account — the person keeps their password-login address unless they change it themselves.

### `GET /auth/google-link` — session (browser redirect flow) [AUD]
Self-service "Connect NNT Google account" from `/account`: the OAuth flow bound to the **current session's user**; on success stores `google_sub` on that account regardless of the Google address (hd check still applies). Sensitive operation: requires a fresh session (login within the last 10 minutes; otherwise 302 back to `/account?error=stale-session`). Refuses if the Google identity is already linked to another account (that's a merge situation, not a link). *(Amended at build time: originally spec'd as `POST /api/account/link-google`, but the OAuth dance is a browser redirect flow — a GET route with its own registered redirect URI. Same contract, different verb/path.)*

### `POST /api/auth/email/request` — session [RL]
Resend verification email. Enumeration-safe.

### `POST /api/auth/email/verify` — public
`{ token }` → sets `email_verified`, consumes token, refreshes session if it belongs to the caller.

### `POST /api/auth/password/forgot` — public [RL]
`{ email }` → always `{ ok: true }`. Sends reset email iff the account exists (shadow accounts included — this is the account-claiming path advertised in booking confirmations).

### `POST /api/auth/password/reset` — public [RL]
`{ token, password }` → sets password, consumes token, bumps `session_epoch` (invalidate old sessions), seals a fresh session.

## Session maintenance

### `GET /api/session/refresh` — session
Query `?redirect=<url>` (validated against the allowlist). Re-reads user + roles from DB; **rejects** (clears session, redirects to login) if the user is disabled, erased, or the session's `epoch` ≠ `users.session_epoch`; otherwise re-seals with fresh `roles`/`refreshedAt` and 302s to the redirect. Consumer apps' privileged middleware bounces here when `refreshedAt` is older than 15 min ([session-contract.md](session-contract.md)). Also callable as `POST` returning JSON for server-to-server use.

## Users & admin

All require session + `auth:ADMIN` unless noted. All mutations **[AUD]**.

| Endpoint | Purpose |
|---|---|
| `GET /api/users?q=&page=` | Search/list (email, name; filters: role, guest, disabled) |
| `POST /api/users` | Create user `{ email, name, roles? }` → sends **set-password email** (no generated passwords in responses — deliberate change from rooms's old flow) |
| `GET /api/users/:id` | Profile incl. roles, linked Google, `last_login`, legacy ids |
| `PUT /api/users/:id` | Update `name` / `email` (re-verification triggered on email change) |
| `PUT /api/users/:id/roles` | Replace role set `{ roles: string[] }` — scoped strings validated `^[a-z][a-z0-9-]*:[A-Z][A-Z0-9_]*$` |
| `POST /api/users/:id/reset-password` | Admin-initiated reset (24 h token, emailed; cannot target self) |
| `POST /api/users/:id/force-logout` | Bumps `session_epoch` |
| `POST /api/users/:id/disable` / `enable` | Disabled users can't log in and fail refresh |
| `POST /api/users/:id/unlink-google` | Clears `google_sub` (guard: refuse if it would leave the account with no login method) |
| `PUT /api/users/:id/pending-google` | Set/clear `pending_google_email` — admin-directed link: the next Google sign-in with that address attaches to this account. Validated `@newtheatre.org.uk`; refuses addresses already linked or pending elsewhere |
| `GET /api/users/:id/export` | Subject-access bundle: auth record + each app's hook contribution ([gdpr-retention.md](gdpr-retention.md)) — Phase 7 |
| `POST /api/users/:id/erase` | Anonymise everywhere (auth + app hooks + epoch bump) — Phase 7. Also available self-service from `/account`. |
| `GET /api/audit?actor=&action=&page=` | Audit log query |

Self-service (session, own account only — all verify the account live: exists, not disabled, epoch current):

| Endpoint | Purpose |
|---|---|
| `GET/PUT /api/account/profile` | Own profile; email change resets verification + sends a new link, and is enumeration-safe on conflict (generic `{ ok: true }`, "you already have an account" email to the requested address) |
| `PUT /api/account/password` | Change — or, for SSO-only accounts, set — the password. Verifies the current password where one exists; bumps epoch; re-seals this session |
| `POST /api/account/unlink-google` **[AUD]** | Disconnect Google; refuses if it would leave no login method |
| `POST /api/account/logout-everywhere` **[AUD]** | Bump own epoch + clear this session |
| `GET /api/account/export`, `POST /api/account/erase` | Phase 7 |

## Service-token administration

Session + `auth:ADMIN`, mutations **[AUD]**: `GET /api/service-tokens` (names + usage, hashes never leave the DB), `POST /api/service-tokens { name }` → `{ token }` shown once, `DELETE /api/service-tokens/:id` (revoke). Procedure: [operations.md](operations.md#service-tokens).

`POST /api/audit { action, target, detail? }` — record a manual operation (secret rotation etc.); stored with a `manual.` action prefix so it can't impersonate system entries.

## Service endpoints

### `POST /api/users/shadow` — service [AUD]
`{ email, name }` → match on lowercased email or create `{ password: NULL, email_verified: false }`. Returns `{ id, existing: boolean, guest: boolean }`. Used by Proscenium's guest checkout. Idempotent by email. If the email belongs to a full account, returns that account's id (`existing: true, guest: false`) — the booking attaches to their history.

### `GET /api/health` — public
`{ ok: true, version }` for uptime checks.

## App hooks (implemented by consumer apps, called by the auth service)

Each integrated app exposes, authenticated by the **same service token** it uses inbound:

| Hook | Contract |
|---|---|
| `POST <app>/api/_hooks/auth/export` | `{ userId }` → `{ data: <JSON-serialisable app-held personal data> }` |
| `POST <app>/api/_hooks/auth/anonymise` | `{ userId }` → rewrite mirror row to anonymised values, scrub free-text personal data (e.g. `customer_notes`), return `{ ok: true }`. Must be idempotent. |
| `POST <app>/api/_hooks/auth/last-activity` | `{ userIds: [] }` → `{ [userId]: epochMs \| null }` — feeds the retention sweep |

Hook base URLs are registered per app in the auth service config ([integrating-an-app.md](integrating-an-app.md)). Reserve the shapes from day one even though callers ship in Phase 7.

## Redirect validation (applies to every `?redirect=`)

Allowlist: `^https://([a-z0-9-]+\.)?newtheatre\.org\.uk(/|$)`. Anything else — including protocol-relative, `javascript:`, and lookalike domains — falls back to `https://newtheatre.org.uk`. Never reflect the rejected value.
