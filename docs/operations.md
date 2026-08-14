# Operations Runbook

Procedures for whoever holds `auth:ADMIN` — normally the IT Manager/Archivist, with the continuity holder as backup. Written so a competent successor can operate the service from this document alone. Access needed: Cloudflare account (worker + D1), the committee password manager, GitHub `newtheatre` org.

## Deployments

Deploys are handled by Cloudflare's Workers Builds git integration — pushing `main` builds and deploys automatically. GitHub Actions runs test + lint only (`.github/workflows/ci.yml`). Manual fallback — wrangler auth here spans multiple Cloudflare accounts, so the account id must be explicit:

```bash
bun run build
CLOUDFLARE_ACCOUNT_ID=3d250a94794003bd921b7f0379de7f00 npx wrangler --cwd .output deploy
```

Migrations are applied explicitly, not automatically. The build-generated wrangler config resolves its migrations path wrongly when invoked standalone — use the checked-in `wrangler.d1.jsonc`:

```bash
npx wrangler d1 migrations list auth --remote -c wrangler.d1.jsonc    # what's pending
npx wrangler d1 migrations apply auth --remote -c wrangler.d1.jsonc   # apply during a quiet window
```

Rollback = redeploy the previous commit. **Migrations don't roll back** — D1/SQLite rebuilds tables; if a migration is bad, write a forward migration that fixes it. Before any migration touching `users`: `npx wrangler d1 export auth --remote --output backup-$(date +%F).sql` and keep it until verified. (Cutover lesson, 2026-08-12: verify a target DB's *actual* schema before applying a migration written against the schema files — the live Proscenium DB turned out to be a copy that had missed one earlier migration, and the batch failed wholesale on a DROP of a column it never had.)

## Backups

Weekly `wrangler d1 export` of the `auth` DB to the `nnt-db-backups` R2 bucket (`.github/workflows/backup.yml`, Mondays 04:00 UTC; first Monday of the month also writes a `monthly/` copy — this workflow is the one thing that still needs the `CLOUDFLARE_API_TOKEN` repo secret: D1:Edit + R2:Edit). Retention is enforced by R2 lifecycle rules on the bucket — `weekly/` expires at 70 days, `monthly/` at 400 (they contain personal data — retention policy applies to backups too). Restore drill: import into a fresh local SQLite, run the app against it, log the result in the estate tracker annually at handover.

## Secrets inventory

| Secret | Where set | Where recorded |
|---|---|---|
| `NUXT_SESSION_PASSWORD` | Worker secret on auth + **every** consumer app | Password manager → "NNT session seal" |
| `NUXT_RESEND_API_KEY` | Auth worker | Password manager |
| `NUXT_OAUTH_GOOGLE_CLIENT_ID/SECRET` | Auth worker | Password manager (Google Cloud project: NNT Workspace) |
| Service tokens (one per app) | Consumer app workers (`AUTH_SERVICE_TOKEN`) | Password manager, one entry per app |

## Rotating the session seal secret

**Effect: every user on every app is logged out immediately.** This is the estate-wide kill switch — use it for suspected secret compromise, or on a calm schedule (annually at handover, term-time avoided).

1. Generate: `openssl rand -base64 48`.
2. Update the password-manager entry.
3. `npx wrangler secret put NUXT_SESSION_PASSWORD` on **auth first**, then each consumer app, then redeploy each (workers read secrets at deploy). Order matters only in that until an app is updated its users appear logged out — do them within minutes of each other.
4. Post a brief "you'll need to log in again" notice if done outside an incident.
5. Audit-log it (the admin UI has a "record manual action" entry; use it).

## Service tokens

Issue (new app or rotation): admin UI → Service Tokens → New. The plaintext `nnt_svc_…` value is shown **once**; put it straight into the password manager and the app's worker secret. Revoke the old row after the app redeploys. Tokens have no expiry — rotate at handover and on any suspicion. `last_used_at` going stale for an active app is a sign something's misconfigured.

Historical note: the `proscenium` and `rooms` tokens issued at cutover (2026-08-11/12) were minted straight into the DB + worker secrets without the plaintext ever being displayed — so they are **not in the password manager**. That's fine operationally (nothing needs the plaintext again), but rotate them via the admin UI at the next convenient moment so the password manager holds a copy per the table above.

## User operations (admin UI, `/admin`)

| Task | How | Notes |
|---|---|---|
| Password reset for someone | User → Reset password | Sends 24 h set-password email. Never read or set a password yourself. |
| Grant/revoke roles | User → Roles | Pick from the definitions dropdown (expiry pre-filled — committee-year roles lapse 31 July automatically); free-text behind Advanced. Renewal = edit the expiry date on the grant (one click; re-arms the 14-day warning). Takes effect within 15 min on privileged surfaces; for instant effect, also Force logout. |
| Force logout one user | User → Force logout | Bumps session epoch; their sessions die at next refresh/privileged action. |
| Disable an account | User → Disable | Blocks login and refresh. Use for compromise or misuse; it is reversible, erasure is not. |
| Erasure (GDPR) | User → Data & GDPR → Erase… | Anonymises auth + all app data via hooks. **Irreversible** (typed email confirmation required). Confirm identity of the requester first; note the request date (one-month statutory clock). If a hook fails the erasure reports incomplete — fix the app and re-run (idempotent). |
| Subject-access export | User → Data & GDPR → Download | Produces the JSON bundle; send securely to the verified requester. |
| Reset someone's second factor | User → Two-step sign-in → Reset | The "lost my phone / lost my recovery codes" path. **Verify who you're talking to out of band first** — this removes their protection entirely. They can still sign in with their password; admin tools stay closed until they re-enrol. Audit-logged. |
| Clear a password on an NNT address | User → Two-step sign-in → Clear password | For handed-over role accounts: link their Google account, re-grant the roles to the person's own account, then clear the password so the address is Google-only (ADR-0012). Refuses unless Google is linked. The `/admin` dashboard banners list who's left. |
| Merge duplicate accounts | User → Merge accounts (from the WINNER's page) | Review the dry-run report, then type the absorbed account's email. The absorbed account is **erased** — irreversible short of a backup restore. Hooks-first: a site being unreachable aborts with nothing changed; re-run once it's back. **Never merge accounts belonging to two different people** — shared mailboxes happen; a merge is for one person's duplicates only. Second factors don't move: a privileged winner may need to re-enrol two-step sign-in. |
| Annual handover | See below | |

### When someone loses their second factor

1. Confirm identity **out of band** — in person, or a video call, or via a committee member who knows them. An email asking for an MFA reset is exactly what an attacker sends.
2. Reset from their user page (above), and tell them to re-enrol immediately at `/account`.
3. If they still hold their recovery codes, don't reset — one code signs them in, and they can regenerate the set afterwards.

**The `auth:ADMIN` exception.** There may be no second admin to reset *you*. Before enrolling, put your recovery codes in the committee password manager; that is the only path back if you lose your phone. If it happens anyway, recovery means editing the D1 database directly (`npx wrangler d1 execute auth --remote --command "delete from totp_secrets where user_id = '…'"`) — which requires the Cloudflare account, so guard that access accordingly.

## Annual handover checklist (add to the Archivist runbook)

1. Incoming ITM granted `auth:ADMIN`; outgoing revoked (after a two-week overlap). Committee-year roles lapse automatically on 31 July — the old revoke-everything sweep shrinks to **reviewing permanent grants** (`/admin`, filter by role).
2. Rotate: session seal secret, all service tokens, Resend key. (Google OAuth secret only if the outgoing ITM had raw access.)
3. Password-manager access transferred per the Workspace policy — including the incoming ITM's **recovery codes** (see above) and any shared account's TOTP seed.
4. Review `audit_log` for the year (spot-check), review role grants for leavers.
5. Run the backup-restore drill; log it in the estate tracker.
6. Read this doc top to bottom; fix anything that's drifted.

## Incidents

**Suspected session-secret leak** (any worker compromised, secret pasted somewhere, laptop stolen with password-manager access): rotate the seal secret (above) *now*, then investigate. Cost is one mass logout — always cheaper than doubt.

**Suspected single-account compromise**: Force logout + Disable, admin password reset, review `audit_log` and the app-side records for that user, re-enable once resolved.

**Auth service down**: consumer apps keep working for logged-in users (sessions verify locally) except privileged surfaces past the 15-minute staleness window and new logins/guest checkouts. Check Cloudflare status, worker logs (`npx wrangler tail stage-door`), recent deploys; roll back first, diagnose second.

**Resend down / emails not arriving**: registration and reset flows degrade. Check Resend dashboard + DNS (SPF/DKIM on `newtheatre.org.uk`). Verification emails can be re-requested by users once fixed; nothing is lost.

**D1 corruption/data loss**: restore latest weekly export into a new D1 database, repoint the binding, accept the gap (document what was lost in the audit log). This is why the weekly export exists.

**Escalation path**: ITM → continuity holder (`auth:ADMIN` #2) → alumni IT admins (Sam Osborne, Will Pimblett — see estate tracker contacts) → Cloudflare support (free-tier community). There is no on-call; this is a student theatre — the estate is designed to fail soft.

## Monitoring

Cloudflare Workers observability logs are enabled on the worker. `GET /api/health` is polled by the uptime monitor (see estate tracker for which). The retention sweep (daily, 04:00 UTC) emails the Archivist a digest whenever it acts, dry-runs, or on the 1st of each month — its silence is itself an alert. **Arming it**: it ships with `dryRun: true` in `server/utils/retentionConfig.ts`; review a production dry-run digest, then set `dryRun: false` in a PR. Set it back to true after any period change. Worth a glance each term: `audit_log` anomalies, `service_tokens.last_used_at`, Resend bounce rates. The role-expiry digest (daily task, only when grants enter their 14-day window) is the renew-or-let-lapse prompt — act on it or the roles lapse by design.
