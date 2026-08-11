# Roadmap & Revisit Notes

Future work agreed in principle but not yet scheduled. Each item states the problem, the sketched design, and what it touches — enough that a future session (human or Claude Code) can pick it up without re-deriving the thinking. When an item is picked up, it graduates: ADR for the decision, then specs into the main docs.

## R1 — Roles v2: configurable roles with expiry *(committed direction — revisit after Phase 5)*

**Problem.** v1 roles are free-text scoped strings granted indefinitely. Two gaps flagged by the ITM: roles should be **easily configurable** (grantable from a dropdown of known roles, not typed strings with typo risk) and should **support expiry** — which is really the committee-handover problem in disguise: almost every role at the NNT is held for a committee year, and today revoking them all is a manual handover-checklist step that history says gets missed.

**Design sketch.**

- `user_roles` gains `expires_at` (nullable = permanent), `granted_by`, `granted_at`, `note`. **Expiry is enforced at read time**: everywhere roles are loaded into a session (login, SSO, `/api/session/refresh`), filter `expires_at IS NULL OR expires_at > now`. No cron needed for correctness — an expired role vanishes from privileged surfaces within the existing 15-minute staleness window, which is the whole point of having built refresh first. A tidy-up job can delete long-expired rows and is cosmetic.
- New `role_definitions` table: `namespace`, `role`, `description`, `default_expiry` (`none` | `end-of-committee-year` | days). Drives the admin UI: granting becomes pick-user → pick-role-from-dropdown → expiry pre-filled from the default, editable. Free-text grant stays available behind an "advanced" toggle so a namespace can still exist before its definitions do.
- A single config value for the **committee year end** (e.g. 31 July) powers the `end-of-committee-year` default. Granting `proscenium:BOX_OFFICE` in October defaults to expiring 31 July; handover stops depending on anyone remembering to revoke.
- Expiry warnings: 14 days out, email the holder and the ITM digest. Renewal = re-grant (one click, new expiry, audit-logged).
- **ADR impact:** partially supersedes [ADR-0004](decisions/0004-scoped-role-strings.md) — scoped strings stay (sessions, checks, and app code are unchanged), but "no registry" gives way to an *optional* definitions table for UX and defaults. Write ADR-0009 when picked up.
- **Touches:** data-model, api-reference (`PUT /api/users/:id/roles` gains per-role expiry), session-contract **unchanged** (roles remain `string[]` — expiry is a grant property, not a session property; this is deliberate, keep it that way), operations (handover checklist gets shorter), integrating-an-app (namespace table gains a definitions step).

## R2 — MFA *(committed direction — scope decision needed at pickup)*

**Problem.** Email+password admin accounts are protected by a password alone. Workspace/SSO users already have 2SV enforced by Google (see security.md accepted risk #1) — the gap is exactly: admins who log in with a password.

**Design sketch.**

- **Passkeys first, TOTP second.** `nuxt-auth-utils` ships WebAuthn support natively (`runtimeConfig.webauthn` — register/authenticate handlers), so passkeys are the low-dependency path on our existing stack; TOTP would add a library and shared-secret handling. Passkeys also serve as a *primary* login method later (R4) — one credential table, two uses.
- Schema: `webauthn_credentials` (user_id, credential_id, public_key, counter, transports, name, created_at, last_used_at) + `users.mfa_required` (bool). Recovery: 8 single-use recovery codes, hashed, generated at enrolment; admin can also clear MFA for a user (audit-logged, forces re-enrolment) — the "lost their phone" path goes through the ITM, which is fine at this scale.
- Enforcement point: password login succeeds → if `mfa_required` (or the user has credentials enrolled) → half-authenticated state → WebAuthn assert → seal session. SSO logins bypass (Google 2SV upstream). Session gains nothing; MFA is a login-time gate, not a session property.
- **Policy proposal for the committee:** `mfa_required` mandatory for holders of any `*:ADMIN` role who use password login; optional (self-service enrolment on `/account`) for everyone else. Enforce at grant time: granting an admin role to a password-only account without MFA prompts the admin UI to require enrolment on next login.
- **Touches:** api-reference (enrol/assert/recovery endpoints), data-model, security.md (retires accepted risk #1), operations (MFA-reset procedure), development (WebAuthn needs HTTPS or localhost — fine).

## R3 — Account merge tool *(committed direction — build before the training system integrates)*

**Problem.** People will exist before they have a Workspace account — the training system is the forcing case: a fresher's training is recorded against a personal-email account in week 2; a Workspace account may arrive months later, or never. The linking design (architecture.md §identity-continuity: self-service Connect-Google, admin `pending_google_email`, email-change fallback) *prevents* duplicates when used, but duplicates will still occasionally happen — someone signs in with Google before anyone links, and now their training history sits on account A while they're logged into account B.

**Design sketch.** Admin UI "Merge accounts": pick winner + loser → each registered app's **merge hook** (`POST <app>/api/_hooks/auth/merge { fromUserId, toUserId }`, service-token auth'd, idempotent) re-points its user FKs (`UPDATE bookings SET user_id = to WHERE user_id = from`, ditto reservations, training records, push subscriptions) and deletes/absorbs the loser's mirror row → auth service unions roles (earliest expiry wins on conflict), keeps the winner's credentials, moves the loser's `legacy_ids`, records the merge in `legacy_ids` (`source: 'merge'`) and `audit_log` → loser row is anonymised (ADR-0008 machinery reused), epoch-bumped. Typed confirmation; dry-run report first showing exactly what each app will re-point. **Touches:** api-reference (hook + admin endpoint), integrating-an-app (merge hook joins export/anonymise/last-activity as the fourth required hook), operations (procedure + when *not* to merge: two real people sharing an email history).

## R4 — Candidate features *(gathered, not committed — review each year at handover)*

- **Passwordless login for ticket bookers (email one-time code or magic link).** The audience population forgets passwords between shows; a 6-digit emailed code at login would cut forgot-password traffic and pair naturally with shadow-account claiming ("enter the code we sent to confirm it's you"). Small build on existing token machinery + Resend. Probably the highest-value item in this list for actual users.
- **Passkeys as a primary login method** (not just MFA) — free-ish once R2 lands; the login page offers "sign in with a passkey" alongside password/Google.
- **Role sync from Google Workspace Groups.** The theatre already administers committee membership as Workspace role groups (per the Workspace plan); a nightly job could map configured groups → role grants (e.g. members of `boxoffice@` get `proscenium:BOX_OFFICE` with end-of-year expiry), ending double administration. Needs a service account with Groups read scope and careful thought about which direction wins on conflict. Investigate after R1, since it wants expiry semantics to exist.
- **"Sign in with NNT" (OIDC provider mode).** Only if a third-party tool (forum, wiki, external ticketing) ever needs our accounts. Explicitly out of v1 (ADR-0001/0003); would be a significant addition — do not drift into it accidentally.
- **Sessions/devices UI ("log out that library computer").** Requires server-side session state, which ADR-0003 deliberately avoided. The epoch mechanism already gives "log out everywhere"; per-device management is the one thing it can't do. Revisit only if it becomes a real complaint.
- **New-login notification emails** ("new sign-in to your NNT account"). Cheap, but noisy for a population that logs in twice a year; if built, admins-only.
- **Booking-history claim nudge analytics** — measure how many shadow accounts convert after the confirmation-email nudge; informs whether passwordless (above) is worth it.

## Parking rules

Items live here until someone commits a phase to them. Adding an item: state problem + sketch + touches, keep it honest about cost. Removing an item: either it graduated (link the ADR) or record *why* it was dropped — future ITMs deserve the negative result too.
