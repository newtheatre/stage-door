# Security

Threat model, controls, and the review checklist for changes. Read alongside [operations.md](operations.md) (procedures) and CLAUDE.md (invariants).

## Posture in one paragraph

This service protects a student theatre's box office, room bookings, and member accounts: real personal data, small blast radius, one part-time maintainer. The design optimises for **few moving parts and fail-soft behaviour** over enterprise controls: stateless sessions with a shared seal secret and a 15-minute revocation window is a considered trade-off ([ADR-0003](decisions/0003-shared-sealed-cookie-sessions.md)), not an oversight. What is *not* traded away: password handling, enumeration safety, redirect hygiene, SSO assertion checking, audit trail.

## Threat model (what we defend against, honestly)

| Threat | Stance |
|---|---|
| Credential stuffing / brute force | Rate limits per IP + per account on login/register/forgot/magic-link; scrypt hashing; no enumeration signals anywhere. |
| Mailbox compromise | Password reset and magic links both prove only mailbox control, so **neither bypasses an enrolled second factor**: every password-equivalent entry point routes through the `sealOrChallenge` seam (ADR-0013). Emailed tokens are hashed at rest: a database leak yields no live links. |
| Claiming placeholder/anonymised accounts | Register's shadow-claim seals a session with **no email round-trip**, so accounts on undeliverable domains (`.invalid`/`.test`/`example.com`: the legacy import created ~8.3k, one owning reservations with third-party names in notes) were claimable by anyone. `isUndeliverableEmail` makes them unregisterable/unclaimable/unresettable, and the rows are additionally `disabled`. Found and hotfixed 2026-08-11 (PR #10) before any exploitation. The wider class (any existing row, including admin-invited accounts holding grants) was closed on 2026-08-19 by [ADR-0022](decisions/0022-register-never-seals-a-session.md): register no longer seals a session on any path. |
| Phishing of members | **`@newtheatre.org.uk` addresses cannot use password login at all** (ADR-0012): they sign in with Google, inheriting Workspace's enforced 2SV. The residual privileged accounts (personal/SU addresses) must hold a second factor: a passkey, which is phishing-resistant by construction, or an authenticator app. Everyone else may opt in. |
| Open-redirect / OAuth mixups | Strict redirect allowlist; server-side `hd` + `email_verified` checks; `google_sub` linkage (not email) after first sign-in. |
| Session theft (XSS in a consumer app) | `httpOnly` cookie can't be read by JS; but any XSS on any subdomain can *act* as the user. Consumer apps inherit responsibility: standard Nuxt escaping, no `v-html` on user input. This is the price of cookie SSO: noted in every integration review. |
| Session forgery via secret leak | The known weak point. Any worker holding the seal secret can mint sessions for the whole estate. Mitigations: secret only ever in worker secrets + password manager; rotation drill is one command per app; suspected leak = rotate first, ask questions later. |
| CSRF | `SameSite=Lax` + origin check on state-changing endpoints; auth flows are POSTs from same-site forms. |
| Malicious insider / stale admin | `auth:ADMIN` limited to two people; all admin actions audit-logged; role revocation propagates ≤15 min; annual handover rotates everything. |
| Deliberate DB probing via service endpoints | Service tokens hashed at rest, constant-time compared, per-app (revoke one without touching others), `last_used_at` monitored. |
| What we explicitly don't defend against | Nation-state anything; Cloudflare itself being compromised; a malicious ITM (they hold the keys by definition: the audit log and password-manager access records are the deterrent). |

## Controls reference

- **Passwords**: scrypt PHC via nuxt-auth-utils; policy ≥8 chars upper+lower+digit; hashes never leave the auth DB; password change/reset bumps `session_epoch`.
- **Tokens** (verify/reset): `randomBytes(32)` hex, single-use, TTLs 24 h / 1 h / 24 h (admin), outstanding resets invalidated on reissue.
- **Workspace addresses hold no password**: enforced by `assertPasswordAllowed` at every site that writes `users.password` or mints a set-password token (reset redemption, self-service change, admin reset, admin create, and the merge credential fill), not only at the login entry points.
- **Single-use really is single-use**: recovery codes, magic links, MFA login attempts and WebAuthn challenges are all claimed by the *write* (a guarded `UPDATE`/`DELETE` whose affected-row count is the answer), not by a preceding read. D1 has no interactive transactions, so a read-then-write leaves a full round trip in which two requests both see the secret unspent.
- **Enumeration safety**: register, forgot, resend-verification return identical responses regardless of account existence, and register additionally seals no session on any path, so `Set-Cookie` cannot answer the question either (ADR-0022); login's 401 is identical for unknown / wrong-password / guest / disabled. **One deliberate exception**: `@newtheatre.org.uk` addresses get a distinct 403 telling them to use Google (ADR-0012; also on magic-link requests, ADR-0013): the domain policy is a public fact about the address, not about whether an account exists, and a generic error there would strand committee members.
- **Cookies**: `Secure; HttpOnly; SameSite=Lax`, domain `.newtheatre.org.uk`, sealed (encrypted + MACed).
- **Headers**: HSTS via Cloudflare; auth pages send `Cache-Control: no-store`; CSP on hosted UI (default-src 'self', no inline script beyond Nuxt's hydration needs).
- **Logging**: audit log for admin/identity actions; worker logs contain **no** passwords, tokens, or full cookies (assert in code review); `console.log` debugging stripped before merge (rooms shipped one in its login handler: don't repeat it).
- **Dependencies**: `nuxt-auth-utils` pinned; renovate/dependabot on; changelog read before bumping (session config shape has moved between minors before).

## Change-review checklist

For any PR touching auth logic, the reviewer confirms:

- [ ] No new session writer outside the sanctioned handlers
- [ ] Session payload unchanged, or contract version bumped + consumers coordinated
- [ ] Every new endpoint: auth level explicit, rate-limited if public, audit-logged if mutating identity
- [ ] Error paths leak nothing (no user-existence signals, no stack traces)
- [ ] Redirect/URL parameters validated against the allowlist
- [ ] No secret/credential in code, tests, fixtures, or docs
- [ ] Tests updated per [development.md](development.md#testing), including the negative cases
- [ ] If the change weakens any table above → ADR, not a code comment

## Known accepted risks (revisit yearly at handover)

1. ~~No MFA for email+password `*:ADMIN` accounts~~, **closed** by [ADR-0012](decisions/0012-sso-only-workspace-and-mfa.md). Workspace addresses cannot use password login at all (so they inherit Google's 2SV), and the residual password admins must enrol a passkey or an authenticator app: `requireAuthAdmin` refuses admin work until they do. What remains is a smaller, named risk: **an admin who loses both their factor and their recovery codes needs another admin to reset them, and `auth:ADMIN` may have no peer**, hence the standing instruction to keep the ITM's recovery codes in the committee password manager ([operations.md](operations.md)).
2. 15-minute revocation window on privileged surfaces; up to 30-day window on unprivileged reads for a demoted-but-not-force-logged-out user.
3. Shared seal secret across workers (see threat model).
4. Consumer-app XSS ≈ session abuse for that user across the estate.
5. D1 backups are weekly: up to a week of account changes lost in the worst restore case.
