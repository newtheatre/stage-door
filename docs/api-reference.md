# API Reference

Base URL: `https://auth.newtheatre.org.uk`. All bodies JSON. Errors follow Nitro's shape: `{ statusCode, statusMessage }`: no internal detail. Endpoints marked **[RL]** are rate-limited (per-IP and, where meaningful, per-account). Endpoints marked **[AUD]** write to `audit_log`.

Three auth levels:

- **Public**: no session required.
- **Session**: `nnt-session` cookie; some additionally require a role.
- **Service**: `Authorization: Bearer nnt_svc_…` (per-app token, [operations.md](operations.md#service-tokens)).

## Auth flows

### `POST /api/auth/login`: public [RL]

**`@newtheatre.org.uk` addresses are refused with `403 { data: { useGoogle: true } }`**: NNT accounts always sign in with Google (ADR-0012), which brings Google's enforced 2SV. This is the single deliberate exception to enumeration-safe login errors: the domain policy is a public fact about the address, not about whether an account exists. `forgot-password` and `register` no-op for the domain too (enumeration-safe `{ ok: true }`), so a reset can't restore password login.

`{ email, password }` → seals session, updates `last_login`, returns `{ user }`. 401 `Invalid email or password` for unknown user, wrong password, **and** password-less (guest/SSO-only) accounts: indistinguishable by design. Disabled accounts: same 401.

**If the account has a second factor enrolled, no session is sealed.** The response is `{ mfaRequired: true, attemptId, methods: ('totp'|'passkey')[] }`; the client completes at `/api/auth/mfa/verify` (or with a passkey, below). If MFA is *required* of the account (ADR-0012) but nothing is enrolled yet, the session **is** sealed and the response carries `mfaEnrolmentRequired: true`: admin endpoints stay 403 until they enrol.

### `POST /api/auth/mfa/verify`: public [RL]
`{ attemptId, code }` → seals the session and returns `{ user, usedRecoveryCode }`. Accepts a TOTP code or a recovery code; both are single-use (a TOTP step is never accepted twice, a recovery code is marked used and audited). A wrong code burns the attempt and returns `401 { data: { attemptId } }` with a fresh one, so a typo doesn't cost the password step. Attempts expire after 5 minutes.

### `POST /api/webauthn/register`: session [AUD]
Two-leg passkey enrolment (nuxt-auth-utils' route shape): `{ user: { userName, label? }, verify: false }` returns `{ creationOptions, attemptId }`; `{ …, verify: true, attemptId, response }` verifies and stores the credential. The account is always taken from the session, never from the body. Requires a discoverable credential with user verification (PIN/biometric): a presence-only tap is refused. Enrolling a first factor bumps `session_epoch` and re-seals the caller's session.

### `POST /api/webauthn/authenticate`: public [RL]
Same two legs, no `userName`: passkey sign-in is usernameless, so nothing here reveals whether an address has a passkey. On success it seals a full login session: a passkey with user verification is possession plus a factor already, and is phishing-resistant, so it is not treated as a second step after a password.

### `POST /api/auth/register`: public [RL]
`{ email, name, password }` (policy: >=8 chars, upper+lower+digit) -> always `{ ok: true }`, and **never a session** ([ADR-0022](decisions/0022-register-never-seals-a-session.md)). Three outcomes, indistinguishable to the caller:

- **Free address**: creates the user (no roles), sends a verification email. Sign in afterwards with the password just chosen.
- **Claimable row** (no password, no `google_sub`, not disabled): nothing is written. Sends a set-password link, the same `password_resets` token an admin-created account gets; redeeming it at `POST /api/auth/password/reset` sets the password, checks `disabled` and routes through the MFA seam.
- **Full or disabled account**: nothing is written. A full account gets a "you already have an account" email; a disabled one gets nothing.

Addresses on undeliverable domains (`.invalid`/`.test`/`.example`/`example.com|org|net`: see [security.md](security.md)) and Workspace addresses (ADR-0012) get the same generic response with nothing created, claimed, sealed or emailed. `hashPassword` runs before the branch on every path, so scrypt is not a timing oracle. Rate limited per IP **and** per account.

### `POST /api/auth/magic-link/request`: public [RL]
`{ email, redirect? }` → always `{ ok: true }`, emailed iff the account exists and isn't disabled: **shadow accounts included** (the passwordless path for bookers, ADR-0013). The optional `redirect` rides through the email into the link and is validated at consumption, never here. Undeliverable addresses no-op silently; **Workspace addresses get the same deliberate `403 { data: { useGoogle: true } }` as login**. Links live 15 minutes, single-use, one outstanding per user.

### `POST /api/auth/magic-link/verify`: public [RL]
`{ token }` → `{ user }` with a sealed session, or the same `{ mfaRequired, attemptId, methods }` challenge as login: **a magic link replaces the password step, never the second factor** (ADR-0013). Consuming a link also sets `verified` (mailbox proven). Expired/used/unknown/disabled all produce one generic 400. No epoch bump.

### `POST /api/auth/logout`: public (idempotent)
Clears the session cookie (domain-wide), returns `{ ok: true }` whether or not a session existed. Apps POST here; they never clear the cookie themselves. Browser-facing variant: `POST /logout?redirect=<url>` clears and 302s to the validated target.

### `GET /auth/google`: public (browser redirect flow)
Google OAuth via `defineOAuthGoogleEventHandler`. The redirect target rides the round-trip in the OAuth `state` query param (`/auth/google?state=<url>`, validated against the allowlist on return, the login page builds this link). Success handler asserts `hd === 'newtheatre.org.uk'` and `email_verified === true` server-side; on failure 302s to the "not an NNT Google account" page (no session). Disabled accounts get the same rejection page, and **nothing is written for one**: identity resolution commits no `google_sub`, consumes no `pending_google_email` and flips no `email_verified` unless the account is eligible, so a rejected sign-in leaves no trace. Match precedence: existing `google_sub` → account with matching `pending_google_email` (attach + clear it, audit-logged) → lowercased email match (including shadow accounts, claiming them; sets `email_verified` since Google verified that exact address) → create a new verified user. The Google address is **not** written to `users.email` when attaching to an existing account, the person keeps their password-login address unless they change it themselves.

### `GET /auth/google-link`: session (browser redirect flow) [AUD]
Self-service "Connect NNT Google account" from `/account`: the OAuth flow bound to the **current session's user**; on success stores `google_sub` on that account regardless of the Google address (hd check still applies). Sensitive operation: requires a **live** session (account exists, not disabled, session epoch current, else the cookie is cleared and it 302s to login) that is also **fresh** (login within the last `FRESH_SESSION_MS`, 10 minutes; otherwise 302 back to `/account?error=stale-session`). Both are checked before anything is written, so a revoked cookie cannot attach an identity. Refuses if the Google identity is already linked to another account (that's a merge situation, not a link).

### `POST /api/auth/email/request`: live session [RL]
Resend verification email. Enumeration-safe.

### `POST /api/auth/email/verify`: public [RL]
`{ token }` → sets `email_verified`, refreshes the session only if it belongs to the caller **and is still live** (not disabled, epoch current). An id match alone would re-stamp the current epoch onto a cookie `force-logout` had revoked. **Claims the token by deleting it first**, valid or not, like the reset and magic-link routes: without that, requests carrying one token all pass the expiry check together. An expired token is consumed and 400s, and **no mail is sent**: a new link comes from `POST /api/auth/email/request`, which is limited per account, so nothing unauthenticated can spend the mail budget. `verify:ip` is a budget of its own (20/hour) rather than the resend one: `/verify-email` POSTs from `onMounted`, so a refresh, a back-navigation or a mail scanner is another request, and most members share one university NAT.

### `POST /api/auth/password/forgot`: public [RL]
`{ email }` → always `{ ok: true }`. Sends reset email iff the account exists (shadow accounts included: this is the account-claiming path advertised in booking confirmations).

### `POST /api/auth/password/reset`: public [RL] [AUD]
Refuses a Workspace address with 403 (`assertPasswordAllowed`, ADR-0012), as do `PUT /api/account/password`, `POST /api/users/:id/reset-password` and `POST /api/users`. The rule lives at the write boundary: the login-side checks alone could not stop an admin-minted token from restoring a password.

`{ token, password }` → **claims the token by deleting it first**, valid or not, so two requests carrying one token cannot both redeem it ([security.md](security.md) §single-use); then sets password, bumps `session_epoch` (invalidate old sessions), then **the same MFA seam as login** (ADR-0013): no factors → seals a fresh session, `{ ok: true }`; enrolled → `{ mfaRequired, attemptId, methods }` and no session: the password changed but the factor still gates. Mailbox control alone no longer logs in an enrolled account. Writes `user.password-changed` with `detail: { via: 'reset-token' }`, matching the self-service change, and writes it above the disabled-account refusal because the password write lands either way.

## Session maintenance

### `GET /api/session/refresh`: session
Query `?redirect=<url>` (validated against the allowlist). Re-reads user + roles from DB; **rejects** (clears session, redirects to login) if the user is disabled, erased, or the session's `epoch` ≠ `users.session_epoch`; otherwise re-seals with fresh `roles`/`refreshedAt` and 302s to the redirect. Consumer apps' privileged middleware bounces here when `refreshedAt` is older than 15 min ([session-contract.md](session-contract.md)). Also callable as `POST` returning JSON for server-to-server use.

## Users & admin

All require session + `auth:ADMIN` unless noted. All mutations **[AUD]** (enforced by `tests/audit-coverage.test.ts`, which fails if a non-GET route under `server/api/account` or `server/api/users` neither calls `writeAudit` nor delegates to a helper that does; deliberate exemptions are listed there with their reason).

| Endpoint | Purpose |
|---|---|
| `GET /api/users?q=&page=` | Search/list (email, name; filters: role: **active holders only**, guest, disabled). Anonymised/placeholder accounts (undeliverable domains) are excluded by default and counted in `hiddenAnonymised`; `anonymised=true` lists only them. `attention=workspace-password\|admin-no-mfa` filters the two ADR-0012 rollout lists, whose standing counts are returned as `needsAttention` |
| `POST /api/users` | Create user `{ email, name, roles? }` → sends **set-password email** (no generated passwords in responses: deliberate change from rooms's old flow) |
| `GET /api/users/:id` | Profile incl. roles, linked Google, `last_login`, legacy ids, and `mfa` (required? which factors, passkey count, recovery codes left: never a secret) |
| `PUT /api/users/:id` | Update `name` / `email` (re-verification triggered on email change). Refuses an `@newtheatre.org.uk` target address with a 403: those are claimed by signing in with Google, never by an admin typing one here (ADR-0012) |
| `PUT /api/users/:id/roles` | Refuses to remove the last **usable** `auth:ADMIN` grant, or to give it an expiry when it is the only one (`requireAuthAdmin` re-reads roles per request, so losing it closes every admin route including this one, with no in-app recovery). Usable means unexpired **and** held by an account that is not disabled: disable leaves the grant row behind, and a holder nobody can sign in as is not a fallback. Replace grant set `{ roles: Array<string \| { role, expiresAt?: epoch-ms\|null, note? }> }`: bare strings = permanent grants (back-compat). Applied as a diff in one `db.batch`, so a failure part-way leaves the grant set exactly as it was: unchanged grants keep provenance; a changed expiry clears the warning flag (renewal re-arms it). Duplicates 400. **New grants must match a role definition** (400 naming the role, ADR-0014); roles the user already holds are exempt, so definition-less history (`ticketing:*`) stays editable. At most 100 grants per request: the diff is one batch, so an uncapped array would turn body size into batch size |
| `POST /api/users/:id/reset-password` | Admin-initiated reset (24 h token, emailed; cannot target self) |
| `POST /api/users/:id/force-logout` | Bumps `session_epoch` |
| `POST /api/users/:id/disable` / `enable` | Disabled users can't log in and fail refresh |
| `POST /api/users/:id/unlink-google` | Clears `google_sub` (guard: refuse if it would leave the account with no login method) |
| `POST /api/users/:id/merge` | Absorb another account into `:id` (the winner): `{ loserId, confirmEmail?, dryRun? }`. Dry run returns the full plan (role outcomes, credential gains, per-app counts, warnings) with no writes; a commit requires `confirmEmail` matching the LOSING account and runs hooks-first: a hook failure changes nothing central and is re-runnable (ADR-0015). The loser is erased |
| `POST /api/users/:id/mfa-reset` | Cannot target yourself, like `clear-password`, `unlink-google`, `erase`, `disable` and `reset-password`; `force-logout` and `pending-google` deliberately can. | Clear every second factor: the "lost my phone" path. Verify identity out of band first ([operations.md](operations.md)); the account keeps working but admin tools stay closed until they re-enrol. Bumps the session epoch, so sessions sealed behind the removed factors die too |
| `POST /api/users/:id/clear-password` | Null the password so the account can only use Google (ADR-0012). Refuses unless Google is linked: clearing first would lock the account out. Bumps `session_epoch` |
| `PUT /api/users/:id/pending-google` | Set/clear `pending_google_email`: admin-directed link: the next Google sign-in with that address attaches to this account. Validated `@newtheatre.org.uk`; refuses addresses already linked or pending elsewhere |
| `GET /api/users/:id/export` | Subject-access bundle: auth record + each app's hook contribution ([gdpr-retention.md](gdpr-retention.md)) |
| `POST /api/users/:id/erase` | Anonymise everywhere (auth + app hooks + epoch bump). Requires `{ confirmEmail }` matching the account; cannot target self; returns per-hook status and is idempotent: re-POST to retry failed hooks. Also self-service from `/account`. |
| `GET /api/eligibility-syncs` | Eligibility rule sync status: `{ syncs: [{ ruleKey, lastAttemptAt, lastSuccessAt, userCount, lastError, stale }] }`, one row per rule a role definition references. `stale` means never answered, or last answered over a day ago, which is what the Role definitions banner shows ([ADR-0019](decisions/0019-training-conditional-grants.md)) |
| `GET /api/audit?actor=&action=&page=` | Audit log query |

An erased account is refused with a 400 by every route that would write identity, roles or a pending Google link back onto it: `PUT /api/users/:id`, `PUT /api/users/:id/roles`, `PUT /api/users/:id/pending-google`, `POST /api/users/:id/eligibility-override`, `POST /api/users/:id/enable` and `POST /api/users/:id/reset-password` ([gdpr-retention.md](gdpr-retention.md)).

Self-service (session, own account only: all verify the account live: exists, not disabled, epoch current):

| Endpoint | Purpose |
|---|---|
| `GET/PUT /api/account/profile` | Own profile; email change resets verification + sends a new link, bumps `session_epoch` (this session is re-sealed, the rest die), and is enumeration-safe on conflict (generic `{ ok: true }`, "you already have an account" email to the requested address). An `@newtheatre.org.uk` target address is refused with a 403 (ADR-0012) |
| `PUT /api/account/password` | Change, or, for SSO-only accounts, set, the password. Verifies the current password where one exists; bumps epoch; re-seals this session |
| `POST /api/account/unlink-google` **[AUD]** | Disconnect Google; refuses if it would leave no login method |
| `POST /api/account/logout-everywhere` **[AUD]** | Bump own epoch + clear this session |
| `GET /api/account/mfa` | Own factor status: `{ required, factors, passkeys, recoveryCodesRemaining }` |
| `POST /api/account/mfa/totp` | Begin TOTP enrolment → `{ secret, uri }`. Nothing gates a login until it's confirmed, so an abandoned setup can't lock anyone out |
| `POST /api/account/mfa/totp-confirm` **[AUD]** | `{ code }` proves the app works and arms it. First enrolment returns `{ recoveryCodes }` **once**, bumps epoch, re-seals this session |
| `POST /api/account/mfa/recovery-codes` **[AUD]** | Regenerate the eight codes; returns them once and invalidates the old set |
| `DELETE /api/account/mfa/:id` **[AUD]** | Remove a passkey (row id) or the literal `totp`. Refuses to remove your last factor (counted in credentials, so a second passkey is enough) while MFA is required of the account. Removing the last factor deletes the recovery codes with it, in the same batch: they are a factor, and leaving them live means a set the member may no longer hold comes back the moment anything is re-enrolled |
| `GET /api/account/export` | Own subject-access bundle (JSON download) |
| `POST /api/account/erase` **[AUD]** | Close own account: `{ confirmEmail, password? }`: irreversible anonymisation everywhere, session cleared. Requires a **fresh** session (login within the last 10 minutes, `FRESH_SESSION_MS`, the same gate `GET /auth/google-link` uses) and, where the account holds a password, that password. A Google-only account has no password to ask for, so freshness is the whole barrier: logging in again means a Google re-auth, which carries Workspace 2SV. Returns the same per-hook status as the admin route; `/account` shows the member which sites have not confirmed rather than reporting success, because they cannot retry it themselves once their own row is scrubbed (the nightly sweep re-drives it) |

## Service-token administration

Session + `auth:ADMIN`, mutations **[AUD]**: `GET /api/service-tokens` (names + usage, hashes never leave the DB), `POST /api/service-tokens { name }` → `{ token }` shown once, `DELETE /api/service-tokens/:id` (revoke). Procedure: [operations.md](operations.md#service-tokens).

`POST /api/audit { action, target, detail? }`: record a manual operation (secret rotation etc.); stored with a `manual.` action prefix so it can't impersonate system entries.

## Role definitions (ADR-0011)

Session + `auth:ADMIN`: `GET /api/role-definitions` only (each with computed `defaultExpiresAt`, what a grant made now would default to, and `holders`, the count of active grants on real accounts, matching what `GET /api/users?role=` lists).

**There are no write routes** ([ADR-0024](decisions/0024-role-definitions-come-only-from-manifests.md)): a definition comes from its app's manifest, so adding or changing a role is a deploy of the app that owns it. This service declares its own `auth:*` roles the same way, at `GET /api/_hooks/auth/manifest`, and the sync reads that one in-process rather than fetching itself. `ticketing:*` remains frozen `source: 'manual'` history ([ADR-0010](decisions/0010-legacy-roles-dormant-namespace.md)); nothing can create another.

The daily `roles:expiry-warn` task emails holders 14 days before a grant lapses and digests to the ITM.

## App registry (ADR-0017)

Session + `auth:ADMIN`, mutations **[AUD]**: `GET /api/apps` (each with `hasToken`, false where no `service_tokens` row shares the name: such an app cannot be called at all), `POST /api/apps { name, namespace, displayName, baseUrl, hooksEnabled }` (409 on a duplicate name or namespace; links an already-issued token of the same name), `PUT /api/apps/:id { displayName, baseUrl, hooksEnabled }` (name and namespace immutable), `DELETE /api/apps/:id` (**withdraws every live role definition in the app's namespace and revokes the app's service tokens**, then removes the row, all in one batch: `role_definitions.app_id` has no foreign key to cascade, so a surviving definition would leave a dead role grantable and invisible to the suspect-grant report, and `requireServiceToken` never consults `app_id`, so an orphaned token would keep authenticating a decommissioned app inbound). Grants are untouched, as at any other withdrawal.

`baseUrl` must be https, with no trailing slash. `http://localhost:PORT` is accepted **in development builds only**, and the pattern is anchored, so lookalikes such as `http://localhost.attacker.example` are rejected: hooks and manifest fetches send the app's bearer token to this origin, so a plaintext one in production would hand that token over in the clear. Registering an app needs no deploy of this service.

`POST /api/apps/:id/sync`: session + `auth:ADMIN` **[AUD]**. The "Sync now" button: fetch and reconcile one app's manifest, returning `{ app, ok, unchanged?, error?, counts? }`.

`POST /api/apps/sync`: **service token**. An app asking to be re-read after a deploy. The token names the app, so it can only ever ask for itself. Rate-limited at 12 an hour per app. Returns the same shape.

## Training-conditional grants (ADR-0019)

A role definition may name one of rehearsal's eligibility rule keys and pick `advisory` or `enforcing`, both declared in the owning app's manifest. An **enforcing** prerequisite makes a grant inert when the holder is not in the snapshot: the grant row is untouched and recovers by itself when they re-qualify. **Enforcing is refused on any `ADMIN` role**: an outage would lock out the people who fix it.

`POST /api/users/:id/eligibility-override { role, until, note? }`: session + `auth:ADMIN` **[AUD]**. Lifts an enforcing prerequisite for one grant, for at most 90 days; `until: null` clears it. For a wrong snapshot, or training earned during an outage.

`GET /api/users/:id` and `GET /api/users` report `inert` and `overrideUntil` on each grant, so a held-but-doing-nothing role is visible rather than silently absent.

The snapshot is refreshed by the `eligibility:snapshot` task. **This service never calls rehearsal on a request path**, and a failed sync leaves the previous answer in force. Full failure-direction table: [ADR-0019](decisions/0019-training-conditional-grants.md).

## Suspect grants (ADR-0023)

`GET /api/role-audit`: session + `auth:ADMIN`. Active grants on real accounts whose role matches no live definition, worst first: `unknown-namespace` (no registered app owns it, so it is a typo), `undefined-role` (the app exists but declares no such role), `withdrawn` (the app stopped declaring it).

**Dormant namespaces are excluded** (`ticketing`, [ADR-0010](decisions/0010-legacy-roles-dormant-namespace.md), configured in `rolesConfig.ts`), so anything returned is a mistake rather than deliberate history. Surfaced on the role-definitions page and emailed in the daily digest.

## Permissions (ADR-0018)

`GET /api/permissions`: session + `auth:ADMIN`. The estate's declared permission vocabulary, each with the role definitions that carry it and how many people actively hold one. This is the "who can approve refunds?" query, served from one join on `role_definition_permissions.permission_id`.

A permission an app stops declaring reports `active: false` rather than disappearing: role links and audit detail reference the row. Permissions are never in the session; apps resolve them locally from their own manifest (see [session-contract.md](session-contract.md)).

## Manifest ingestion (ADR-0018)

Each app serves `GET /api/_hooks/auth/manifest`, authenticated by the SHA-256 of its own service token. The document:

```jsonc
{
  "contract": 1,
  "namespace": "rooms",          // must equal the registry row; 'auth' is always refused
  "version": "1",                // free text, echoed in the admin UI, never parsed
  "permissions": [{ "key": "booking.read.any", "description": "See any booking" }],
  "roles": [{
    "role": "ADMIN",
    "description": "Room-booking admin",
    "defaultExpiry": { "kind": "committee-year" },   // none | committee-year | days
    "permissions": ["booking.read.any"],             // must all be declared above
    "requiresEligibility": null                      // or { key, suggestedMode }
  }],
  "eligibilityRules": []         // rehearsal only: the questions it can answer
}
```

Reconciliation is described in full in [ADR-0018](decisions/0018-manifest-declared-roles.md). The rule to know: **a manifest that does not fetch and parse changes nothing at all.** The stored document stays in force, the error surfaces in `/admin/apps`, and no role is withdrawn.

## Service endpoints

### `POST /api/users/shadow`: service [AUD]
`{ email, name }` → match on lowercased email or create `{ password: NULL, email_verified: false }`. Returns `{ id, existing: boolean, guest: boolean }`. Used by Proscenium's guest checkout. Idempotent by email. If the email belongs to a full account, returns that account's id (`existing: true, guest: false`): the booking attaches to their history.

### `GET /api/role-holders?roles=A,B`: service [AUD]
Who currently holds these roles, so a consumer app can offer a picker of its own people instead of making staff type an exact email. Returns `{ namespace, holders: [{ id, name }] }`.

**Roles are bare names and the namespace is the caller's own**, taken from the registered app whose `name` matches the service token's: a token named `proscenium` asking for `COMMITTEE` is answered about `proscenium:COMMITTEE`, and no app can ask who holds another app's roles. A token whose name matches no registered app is `403`. The `name` join is deliberate: `service_tokens.app_id` is a reporting column that a rotated token does not carry ([ADR-0017](decisions/0017-app-registry.md)).

Holders are **effective**, not merely granted: an expired grant, or one whose enforcing training prerequisite is unmet, is not a holder ([ADR-0011](decisions/0011-role-definitions-and-expiry.md), [ADR-0019](decisions/0019-training-conditional-grants.md)). Disabled and anonymised accounts are excluded. At most 10 roles per question and 200 holders per answer, so the bound parameter count is fixed.

**Id and name only.** A picker needs no more, and the less that crosses an app boundary the better. Consumers resolve the id against their own user mirror.

### `GET /api/health`: public
`{ ok: true, version }` for uptime checks. Returns **503** with `{ ok: false, version, pendingMigrations: [] }` when the migration journal compiled into the build is ahead of `_hub_migrations`: the deployed code was built against a schema this database does not have ([ADR-0021](decisions/0021-migrations-apply-in-ci.md)).

## App hooks (implemented by consumer apps, called by the auth service)

Each integrated app exposes these, authenticated by the **SHA-256 of its own service token** (`Authorization: Bearer <sha256hex>`): the app derives the hash from its `AUTH_SERVICE_TOKEN` secret and compares constant-time; the auth service sends the hash it already stores. No plaintext is stored or transmitted, and the hash is useless *inbound* against the auth service (inbound auth needs the preimage). *(Amended at build time from "the same service token": the auth service deliberately never holds plaintext tokens.)*

| Hook | Contract |
|---|---|
| `POST <app>/api/_hooks/auth/export` | `{ userId }` → `{ data: <JSON-serialisable app-held personal data> }` |
| `POST <app>/api/_hooks/auth/anonymise` | `{ userId }` → rewrite mirror row to anonymised values, scrub free-text personal data (e.g. `customer_notes`), return `{ ok: true }`. Must be idempotent. |
| `POST <app>/api/_hooks/auth/last-activity` | `{ userIds: [] }` → `{ [userId]: epochMs \| null }`: feeds the retention sweep |
| `POST <app>/api/_hooks/auth/merge` | `{ fromUserId, toUserId, dryRun? }` → `{ ok: true, notMirrored, counts }`: re-point every user-referencing row onto the winner, delete the losing mirror row; `dryRun` returns counts only. Must be idempotent (ADR-0015) |

Hook base URLs come from the [`apps` registry](#app-registry-adr-0017), not from code. An app receives hooks once it has a registry row with `hooks_enabled` and a service token of the same name.

## Redirect validation (applies to every `?redirect=`)

Allowlist: `^https://([a-z0-9-]+\.)?newtheatre\.org\.uk(/|$)`. Anything else, including protocol-relative, `javascript:`, and lookalike domains, falls back to `https://newtheatre.org.uk`. Never reflect the rejected value.
