# Operations Runbook

Procedures for whoever holds `auth:ADMIN`: normally the IT Manager/Archivist, with the continuity holder as backup. Written so a competent successor can operate the service from this document alone. Access needed: Cloudflare account (worker + D1), the committee password manager, GitHub `newtheatre` org.

## Deployments

Deploys are handled by Cloudflare's Workers Builds git integration, pushing `main` builds and deploys automatically. **Migrations are applied separately, by `.github/workflows/migrate.yml`** ([ADR-0021](decisions/0021-migrations-apply-in-ci.md)): Workers Builds only builds, and until 2026-08-19 nothing applied migrations at all, which took the estate down for an hour. The workflow follows Proscenium's, which learned the same lesson first: it records a Time Travel restore point before applying, runs `nuxt-db migrate` rather than `nuxt db migrate` (the proxy swallows the exit code, so a failed migration reports success), and gates on the ledger afterwards rather than trusting the CLI. If a deploy ever lands ahead of its migration, `GET /api/health` returns 503 naming the pending files. GitHub Actions runs test + lint only (`.github/workflows/ci.yml`). Manual fallback, wrangler auth here spans multiple Cloudflare accounts, so the account id must be explicit:

```bash
bun run build
CLOUDFLARE_ACCOUNT_ID=3d250a94794003bd921b7f0379de7f00 npx wrangler --cwd .output deploy
```

Migrations are applied explicitly, not automatically. The build-generated wrangler config resolves its migrations path wrongly when invoked standalone: use the checked-in `wrangler.d1.jsonc`:

```bash
npx wrangler d1 migrations list auth --remote -c wrangler.d1.jsonc    # what's pending
npx wrangler d1 migrations apply auth --remote -c wrangler.d1.jsonc   # apply during a quiet window
```

Rollback = redeploy the previous commit. **Migrations don't roll back**, D1/SQLite rebuilds tables; if a migration is bad, write a forward migration that fixes it. Before any migration touching `users`: `npx wrangler d1 export auth --remote --output backup-$(date +%F).sql` and keep it until verified. (Cutover lesson, 2026-08-12: verify a target DB's *actual* schema before applying a migration written against the schema files, the live Proscenium DB turned out to be a copy that had missed one earlier migration, and the batch failed wholesale on a DROP of a column it never had.)

### The `_hub_migrations` ledger holds two spellings

`wrangler d1 migrations apply` records a migration as `0011_mighty_argent.sql`; `nuxt-db migrate` records and *matches on* `0011_mighty_argent`, with no extension. Production's ledger carries a mix, because the pre-cutover migrations were applied with wrangler and everything since has gone through `nuxt-db`.

This bites in a specific, confusing way: `nuxt-db migrate` reads the ledger, matches none of the `.sql` rows against its own convention, decides nothing has been applied, and starts again from `0000`, which fails on `table audit_log already exists`. Meanwhile `.github/scripts/pending-migrations.sh` folds both spellings, so the workflow's own gate reports the correct pending list. **A red apply step with a sane-looking pending list is this mismatch**, not a bad migration.

Fix: give the ledger the extensionless spelling for the migrations it is missing, then re-run the workflow. Take a Time Travel bookmark first (`wrangler d1 time-travel info auth`), since this runs outside the step that records one.

```bash
npx wrangler d1 execute auth --remote --command "INSERT OR IGNORE INTO _hub_migrations (name) VALUES ('0000_little_cassandra_nova')"
```

`name` is `TEXT UNIQUE` and the two spellings are distinct strings, so this is additive and reversible by deleting the rows. `nuxt-db mark-as-migrated <tag>` does the same thing where `NUXT_HUB_CLOUDFLARE_API_TOKEN` is available; it is a repo secret, so the wrangler form is what works from a laptop. Done for `0000`-`0010` on 2026-08-20.

## Backups

Weekly `wrangler d1 export` of the `auth` DB to the `nnt-db-backups` R2 bucket (`.github/workflows/backup.yml`, Mondays 04:00 UTC; first Monday of the month also writes a `monthly/` copy, this workflow is the one thing that still needs the `CLOUDFLARE_API_TOKEN` repo secret: D1:Edit + R2:Edit). Retention is enforced by R2 lifecycle rules on the bucket, `weekly/` expires at 70 days, `monthly/` at 400 (they contain personal data, retention policy applies to backups too). Restore drill: import into a fresh local SQLite, run the app against it, log the result in the estate tracker annually at handover.

## Secrets inventory

| Secret | Where set | Where recorded |
|---|---|---|
| `NUXT_SESSION_PASSWORD` | **Secrets Store** (see below), bound into all four workers | Password manager → "NNT session seal" |
| `NUXT_RESEND_API_KEY` | Auth worker | Password manager. If it is unset or blank in production, `sendEmail` throws a 500 rather than logging the message: bodies carry live reset and magic-link tokens, so the console fallback is development-only. Symptom of a bad deploy is register/forgot 500ing, not silent non-delivery |
| `NUXT_OAUTH_GOOGLE_CLIENT_ID/SECRET` | Auth worker | Password manager (Google Cloud project: NNT Workspace) |
| Service tokens (one per app) | Consumer app workers (`NUXT_AUTH_SERVICE_TOKEN`) | Password manager, one entry per app |
| `NUXT_TRAINING_API_TOKEN` | Auth worker | Password manager. An `nnt_trn_…` token minted in rehearsal's admin, read only by the `eligibility:snapshot` task (ADR-0019). Single-worker, so a plain worker secret rather than the Secrets Store. |

A secret shared by more than one worker lives in the account Secrets Store
(`default_secrets_store`, id `fdfe08b6b01f498fbddbc08c2891cadb`) so there is one
copy to rotate rather than four to keep in step: [ADR-0016](decisions/0016-estate-secrets-in-secrets-store.md).
Single-worker secrets stay plain worker secrets. Store contents:

```bash
npx wrangler secrets-store secret list fdfe08b6b01f498fbddbc08c2891cadb --remote
```

Two things to know before touching it:

- **The store cannot read a value back.** Neither can `wrangler secret list`. The
  password manager is the only place a value survives: losing that entry means
  rotating, not looking it up.
- **The binding is `SESSION_PASSWORD`, the secret is `NUXT_SESSION_PASSWORD`.**
  The `NUXT_` prefix is deliberately dropped on the binding side; a
  NUXT_-prefixed binding breaks session sealing on every app at once. The reason
  is in `server/plugins/0.secrets-store.ts`: read it before adding a binding.

## Rotating the session seal secret

**Effect: every user on every app is logged out.** This is the estate-wide kill switch: use it for suspected secret compromise, or on a calm schedule (annually at handover, term-time avoided).

1. Generate: `openssl rand -base64 48`.
2. Update the password-manager entry.
3. Write it once to the store:
   ```bash
   npx wrangler secrets-store secret update fdfe08b6b01f498fbddbc08c2891cadb \
     --name NUXT_SESSION_PASSWORD --remote
   ```
   No redeploys. Workers pick the new value up as their isolates recycle, so the
   estate converges on its own: expect a few minutes during which some requests
   still seal with the old value.
4. Post a brief "you'll need to log in again" notice if done outside an incident.
5. Audit-log it (the admin UI has a "record manual action" entry; use it).

If sealing looks broken on one app but not another, check that app actually has
the binding: `npx wrangler versions view <version-id> --name <worker>` lists
bindings, and a worker with neither the binding nor a `NUXT_SESSION_PASSWORD`
worker secret returns 500 from `/api/_auth/session` while its homepage still
serves fine.

**"Login works on auth, but app X never shows me as logged in"** is a different
fault with three known causes, none of which errors:

1. A `NUXT_SESSION_PASSWORD` worker secret still set on that app. It *overrides*
   the store binding, `defu` gives `process.env` priority, so the app seals
   with a stale key. Delete it and redeploy. The plugin logs a loud error when
   it sees both.
2. Something in that app read the session before `server/plugins/0.secrets-store.ts`
   hydrated the password. nuxt-auth-utils memoises the password on the first
   read per isolate, so the isolate is anonymous for life. The `0.` prefix
   exists to prevent this; do not rename the file. Middleware is safe, plugins
   are not.
3. The app is running an isolate from before a rotation. Redeploy.

⚠️ **A `200` from `/api/_auth/session` does not mean sessions work.** h3's
`getSession` swallows unseal failures, so a wrong, empty or stale password
still returns `200` with an anonymous `{ id }`. The signature of a healthy
session is a **`user` key in the body**, from a request carrying a real cookie.
Checking status codes alone is what let the 2026-08-14 incident look resolved
while Proscenium was still broken.

## Service tokens

Issue (new app or rotation): admin UI → Service Tokens → New. The plaintext `nnt_svc_…` value is shown **once**; put it straight into the password manager and the app's worker secret. Revoke the old row after the app redeploys, this genuinely overlaps: `service_tokens.name` is not unique, `requireServiceToken` accepts any matching row, and `hookBearer` sends the **newest**, so the app is reachable throughout. Deregistering an app revokes its tokens with it, matched by name, so a rotated token is revoked along with the rest, and withdraws every live role definition in its namespace so its roles stop being grantable. Tokens have no expiry, rotate at handover and on any suspicion. `last_used_at` going stale for an active app is a sign something's misconfigured.

Historical note: the `proscenium` and `rooms` tokens issued at cutover (2026-08-11/12) were minted straight into the DB + worker secrets without the plaintext ever being displayed, so they are **not in the password manager**. That's fine operationally (nothing needs the plaintext again), but rotate them via the admin UI at the next convenient moment so the password manager holds a copy per the table above.

## User operations (admin UI, `/admin`)

| Task | How | Notes |
|---|---|---|
| Password reset for someone | User → Reset password | Sends 24 h set-password email. Never read or set a password yourself. |
| Grant/revoke roles | User → Roles | Pick from the definitions dropdown (expiry pre-filled: committee-year roles lapse 31 July automatically). A role must be defined before it can be granted (ADR-0014); define it under Role definitions first. Renewal = edit the expiry date on the grant (one click; re-arms the 14-day warning). Takes effect within 15 min on privileged surfaces; for instant effect, also Force logout. |
| Register an app | Admin → Apps | Name (matches its service token), role namespace, base URL, hooks on. Needed before GDPR hooks reach it (ADR-0017). No deploy of this service. An app showing no token cannot be called: issue one under Service tokens with the same name. |
| Adopt an app's roles | Admin → Apps → edit → Read its role manifest | Then press Sync now and read the result before leaving it on. Adoption rewrites a hand-made definition's description and expiry from the manifest (ADR-0018). |
| A manifest sync is failing | Admin → Apps | The row is red and names the error. **No role has been withdrawn**: the last good manifest stays in force. Fix the app or its base URL, then Sync now. |
| A role shows as withdrawn | Admin → Role definitions | Its app has stopped reading it, or the app was deregistered. It cannot be granted again; existing holders keep it until you revoke them deliberately. |
| Who can do X? | Admin → Permissions | Every declared permission with the roles that carry it and their holder counts. Beats reading an app's source. |
| Tie a role to training | Admin → Role definitions → edit | Name a rehearsal eligibility rule and pick advisory or enforcing. Enforcing makes the grant inert while the holder is unqualified; it is refused on any ADMIN role. Takes effect at the next snapshot. |
| Someone lost a role they should have | Admin → user → Roles | If it shows inert, their training lapsed or the snapshot is wrong. Fix it in rehearsal and re-run `eligibility:snapshot`, or set an override (max 90 days, audited, lapses on its own). |
| The eligibility snapshot is failing | Admin → Role definitions (banner at the top), and the task log | **Nobody's access has changed**: the last good answer stays in force, and a rule never answered does not enforce at all. The banner lists each rule not answered in the last day with its last error; the same list is emailed to the digest address by the daily task, and each failure writes an `eligibility.snapshot-failed` audit row. Fix rehearsal or the token, then re-run the task. |
| "Can we cache this?" |: | [ADR-0020](decisions/0020-what-this-service-caches.md). Short version: nothing that decides access, ever, outside one request. There is no KV layer and enabling one is infrastructure work, not a config flag. |
| Migrations did not apply | Actions → Migrate | `./.github/scripts/pending-migrations.sh` lists what is pending (read-only; needs `CLOUDFLARE_ACCOUNT_ID` and a D1:Edit token). Re-run the Migrate workflow to apply. Every run records a Time Travel restore point in its job summary before touching anything. |
| `/api/health` returns 503 |: | The deployed code was built against a schema this database does not have. The body names the pending migrations. Run the Migrate workflow; do not roll back unless the migration itself is the problem. |
| A grant does nothing | Admin → Role definitions | Grants matching no live definition are listed there and emailed in the daily digest. Dormant namespaces (`ticketing`, ADR-0010) are excluded, so anything listed is a mistake: revoke it, or define the role. |
| Force logout one user | User → Force logout | Bumps session epoch; their sessions die at next refresh/privileged action. |
| Disable an account | User → Disable | Blocks login and refresh. Use for compromise or misuse; it is reversible, erasure is not. It leaves role grants in place, `auth:ADMIN` included, so re-enabling restores them; the last-admin guard ignores a disabled holder, so disabling one admin never makes it safe for the other to drop their own grant. |
| Erasure (GDPR) | User → Data & GDPR → Erase… | Anonymises auth + all app data via hooks. **Irreversible** (typed email confirmation required). Confirm identity of the requester first; note the request date (one-month statutory clock). If a hook fails the erasure reports incomplete: fix the app and re-run (idempotent). |
| Subject-access export | User → Data & GDPR → Download | Produces the JSON bundle; send securely to the verified requester. |
| Reset someone's second factor | User → Two-step sign-in → Reset | The "lost my phone / lost my recovery codes" path. **Verify who you're talking to out of band first**: this removes their protection entirely. They can still sign in with their password; admin tools stay closed until they re-enrol. Audit-logged. |
| Clear a password on an NNT address | User → Two-step sign-in → Clear password | For handed-over role accounts: link their Google account, re-grant the roles to the person's own account, then clear the password so the address is Google-only (ADR-0012). Refuses unless Google is linked. The `/admin` dashboard banners list who's left. |
| Merge duplicate accounts | User → Merge accounts (from the WINNER's page) | Review the dry-run report, then type the absorbed account's email. The absorbed account is **erased**, irreversible short of a backup restore. Hooks-first: a site being unreachable aborts with nothing changed; re-run once it's back. **Never merge accounts belonging to two different people**, shared mailboxes happen; a merge is for one person's duplicates only. Second factors don't move: a privileged winner may need to re-enrol two-step sign-in. |
| Annual handover | See below | |

### When someone loses their second factor

1. Confirm identity **out of band**: in person, or a video call, or via a committee member who knows them. An email asking for an MFA reset is exactly what an attacker sends.
2. Reset from their user page (above), and tell them to re-enrol immediately at `/account`.
3. If they still hold their recovery codes, don't reset: one code signs them in, and they can regenerate the set afterwards.

**The `auth:ADMIN` exception.** There may be no second admin to reset *you*. Before enrolling, put your recovery codes in the committee password manager; that is the only path back if you lose your phone. If it happens anyway, recovery means editing the D1 database directly (`npx wrangler d1 execute auth --remote --command "delete from totp_secrets where user_id = '…'"`): which requires the Cloudflare account, so guard that access accordingly.

## Annual handover checklist (add to the Archivist runbook)

1. Incoming ITM granted `auth:ADMIN`; outgoing revoked (after a two-week overlap). Committee-year roles lapse automatically on 31 July: the old revoke-everything sweep shrinks to **reviewing permanent grants** (`/admin`, filter by role).
2. Rotate: session seal secret, all service tokens, Resend key. (Google OAuth secret only if the outgoing ITM had raw access.)
3. Password-manager access transferred per the Workspace policy: including the incoming ITM's **recovery codes** (see above) and any shared account's TOTP seed.
4. Review `audit_log` for the year (spot-check), review role grants for leavers.
5. Run the backup-restore drill; log it in the estate tracker.
6. Read this doc top to bottom; fix anything that's drifted.

## Incidents

**Suspected session-secret leak** (any worker compromised, secret pasted somewhere, laptop stolen with password-manager access): rotate the seal secret (above) *now*, then investigate. Cost is one mass logout: always cheaper than doubt.

**Suspected single-account compromise**: Force logout + Disable, admin password reset, review `audit_log` and the app-side records for that user, re-enable once resolved.

**Auth service down**: consumer apps keep working for logged-in users (sessions verify locally) except privileged surfaces past the 15-minute staleness window and new logins/guest checkouts. Check Cloudflare status, worker logs (`npx wrangler tail stage-door`), recent deploys; roll back first, diagnose second.

**Resend down / emails not arriving**: registration and reset flows degrade. Check Resend dashboard + DNS (SPF/DKIM on `newtheatre.org.uk`). Verification emails can be re-requested by users once fixed; nothing is lost.

**D1 corruption/data loss**: restore latest weekly export into a new D1 database, repoint the binding, accept the gap (document what was lost in the audit log). This is why the weekly export exists.

**Escalation path**: ITM → continuity holder (`auth:ADMIN` #2) → alumni IT admins (Sam Osborne, Will Pimblett, see estate tracker contacts) → Cloudflare support (free-tier community). There is no on-call; this is a student theatre, the estate is designed to fail soft.

## Monitoring

Cloudflare Workers observability logs are enabled on the worker. `GET /api/health` is polled by the uptime monitor (see estate tracker for which). The retention sweep (daily, 04:00 UTC) emails the Archivist a digest whenever it acts, dry-runs, has an erasure outstanding, fails to send a warning, or on the 1st of each month, its silence is itself an alert. Read three fields first: `guestSignalsOk` false means an app did not answer the `last-activity` hook, so no guest account was judged that run (check `hooks_enabled` on every registered app); `outstandingErasures` above zero means somebody's erasure is still waiting on an app hook, which the sweep re-drives every run including dry-runs; `sendFailures` above zero means Resend refused a warning, and that account will be warned again tomorrow rather than anonymised unwarned. **Arming it**: it ships with `dryRun: true` in `server/utils/retentionConfig.ts`; review a production dry-run digest, then set `dryRun: false` in a PR. Set it back to true after any period change. Worth a glance each term: `audit_log` anomalies, `service_tokens.last_used_at`, Resend bounce rates. The role-expiry digest (daily task, only when grants enter their 14-day window) is the renew-or-let-lapse prompt, act on it or the roles lapse by design.
