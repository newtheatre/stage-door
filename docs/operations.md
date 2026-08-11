# Operations Runbook

Procedures for whoever holds `auth:ADMIN` — normally the IT Manager/Archivist, with the continuity holder as backup. Written so a competent successor can operate the service from this document alone. Access needed: Cloudflare account (worker + D1), the committee password manager, GitHub `newtheatre` org.

## Deployments

Deploys go through CI on merge to `main` (wrangler). Migrations are applied explicitly, not automatically:

```bash
npx wrangler d1 migrations list auth --remote        # what's pending
npx wrangler d1 migrations apply auth --remote       # apply during a quiet window
```

Rollback = redeploy the previous commit. **Migrations don't roll back** — D1/SQLite rebuilds tables; if a migration is bad, write a forward migration that fixes it. Before any migration touching `users`: `npx wrangler d1 export auth --remote --output backup-$(date +%F).sql` and keep it until verified.

## Backups

Weekly automated `wrangler d1 export` of the `auth` DB to the R2 backups bucket (GitHub Actions cron), retained 8 weeks; monthly snapshots retained 12 months, then deleted (they contain personal data — retention policy applies to backups too). Restore drill: import into a fresh local SQLite, run the app against it, log the result in the estate tracker annually at handover.

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

## User operations (admin UI, `/admin`)

| Task | How | Notes |
|---|---|---|
| Password reset for someone | User → Reset password | Sends 24 h set-password email. Never read or set a password yourself. |
| Grant/revoke roles | User → Roles | Takes effect within 15 min on privileged surfaces. For instant effect, also Force logout. |
| Force logout one user | User → Force logout | Bumps session epoch; their sessions die at next refresh/privileged action. |
| Disable an account | User → Disable | Blocks login and refresh. Use for compromise or misuse; it is reversible, erasure is not. |
| Erasure (GDPR) | User → Erase… | Phase 7. Anonymises auth + all app data via hooks. **Irreversible.** Confirm identity of the requester first; note the request date (one-month statutory clock). |
| Subject-access export | User → Export | Phase 7. Produces the JSON bundle; send securely to the verified requester. |
| Annual handover | See below | |

## Annual handover checklist (add to the Archivist runbook)

1. Incoming ITM granted `auth:ADMIN`; outgoing revoked (after a two-week overlap).
2. Rotate: session seal secret, all service tokens, Resend key. (Google OAuth secret only if the outgoing ITM had raw access.)
3. Password-manager access transferred per the Workspace policy.
4. Review `audit_log` for the year (spot-check), review role grants for leavers.
5. Run the backup-restore drill; log it in the estate tracker.
6. Read this doc top to bottom; fix anything that's drifted.

## Incidents

**Suspected session-secret leak** (any worker compromised, secret pasted somewhere, laptop stolen with password-manager access): rotate the seal secret (above) *now*, then investigate. Cost is one mass logout — always cheaper than doubt.

**Suspected single-account compromise**: Force logout + Disable, admin password reset, review `audit_log` and the app-side records for that user, re-enable once resolved.

**Auth service down**: consumer apps keep working for logged-in users (sessions verify locally) except privileged surfaces past the 15-minute staleness window and new logins/guest checkouts. Check Cloudflare status, worker logs (`npx wrangler tail auth`), recent deploys; roll back first, diagnose second.

**Resend down / emails not arriving**: registration and reset flows degrade. Check Resend dashboard + DNS (SPF/DKIM on `newtheatre.org.uk`). Verification emails can be re-requested by users once fixed; nothing is lost.

**D1 corruption/data loss**: restore latest weekly export into a new D1 database, repoint the binding, accept the gap (document what was lost in the audit log). This is why the weekly export exists.

**Escalation path**: ITM → continuity holder (`auth:ADMIN` #2) → alumni IT admins (Sam Osborne, Will Pimblett — see estate tracker contacts) → Cloudflare support (free-tier community). There is no on-call; this is a student theatre — the estate is designed to fail soft.

## Monitoring

Cloudflare Workers observability logs are enabled on the worker. `GET /api/health` is polled by the uptime monitor (see estate tracker for which). The retention sweep (Phase 7) emails the Archivist a monthly digest — its silence is itself an alert. Worth a glance each term: `audit_log` anomalies, `service_tokens.last_used_at`, Resend bounce rates.
