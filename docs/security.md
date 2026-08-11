# Security

Threat model, controls, and the review checklist for changes. Read alongside [operations.md](operations.md) (procedures) and CLAUDE.md (invariants).

## Posture in one paragraph

This service protects a student theatre's box office, room bookings, and member accounts — real personal data, small blast radius, one part-time maintainer. The design optimises for **few moving parts and fail-soft behaviour** over enterprise controls: stateless sessions with a shared seal secret and a 15-minute revocation window is a considered trade-off ([ADR-0003](decisions/0003-shared-sealed-cookie-sessions.md)), not an oversight. What is *not* traded away: password handling, enumeration safety, redirect hygiene, SSO assertion checking, audit trail.

## Threat model (what we defend against, honestly)

| Threat | Stance |
|---|---|
| Credential stuffing / brute force | Rate limits per IP + per account on login/register/forgot; scrypt hashing; no enumeration signals anywhere. |
| Phishing of members | SSO reduces password reuse for Workspace holders; Workspace itself enforces 2SV per the Workspace policy. Email+password users get standard hygiene (no MFA in v1 — accepted risk; passkeys-first MFA for admins is roadmap R2). |
| Open-redirect / OAuth mixups | Strict redirect allowlist; server-side `hd` + `email_verified` checks; `google_sub` linkage (not email) after first sign-in. |
| Session theft (XSS in a consumer app) | `httpOnly` cookie can't be read by JS; but any XSS on any subdomain can *act* as the user. Consumer apps inherit responsibility: standard Nuxt escaping, no `v-html` on user input. This is the price of cookie SSO — noted in every integration review. |
| Session forgery via secret leak | The known weak point. Any worker holding the seal secret can mint sessions for the whole estate. Mitigations: secret only ever in worker secrets + password manager; rotation drill is one command per app; suspected leak = rotate first, ask questions later. |
| CSRF | `SameSite=Lax` + origin check on state-changing endpoints; auth flows are POSTs from same-site forms. |
| Malicious insider / stale admin | `auth:ADMIN` limited to two people; all admin actions audit-logged; role revocation propagates ≤15 min; annual handover rotates everything. |
| Deliberate DB probing via service endpoints | Service tokens hashed at rest, constant-time compared, per-app (revoke one without touching others), `last_used_at` monitored. |
| What we explicitly don't defend against | Nation-state anything; Cloudflare itself being compromised; a malicious ITM (they hold the keys by definition — the audit log and password-manager access records are the deterrent). |

## Controls reference

- **Passwords**: scrypt PHC via nuxt-auth-utils; policy ≥8 chars upper+lower+digit; hashes never leave the auth DB; password change/reset bumps `session_epoch`.
- **Tokens** (verify/reset): `randomBytes(32)` hex, single-use, TTLs 24 h / 1 h / 24 h (admin), outstanding resets invalidated on reissue.
- **Enumeration safety**: register, forgot, resend-verification return identical responses regardless of account existence; login's 401 is identical for unknown / wrong-password / guest / disabled.
- **Cookies**: `Secure; HttpOnly; SameSite=Lax`, domain `.newtheatre.org.uk`, sealed (encrypted + MACed).
- **Headers**: HSTS via Cloudflare; auth pages send `Cache-Control: no-store`; CSP on hosted UI (default-src 'self', no inline script beyond Nuxt's hydration needs).
- **Logging**: audit log for admin/identity actions; worker logs contain **no** passwords, tokens, or full cookies (assert in code review); `console.log` debugging stripped before merge (rooms shipped one in its login handler — don't repeat it).
- **Dependencies**: `nuxt-auth-utils` pinned; renovate/dependabot on; changelog read before bumping (session config shape has moved between minors before).

## Change-review checklist

For any PR touching auth logic, the reviewer (human, with Claude Code's help) confirms:

- [ ] No new session writer outside the sanctioned handlers
- [ ] Session payload unchanged, or contract version bumped + consumers coordinated
- [ ] Every new endpoint: auth level explicit, rate-limited if public, audit-logged if mutating identity
- [ ] Error paths leak nothing (no user-existence signals, no stack traces)
- [ ] Redirect/URL parameters validated against the allowlist
- [ ] No secret/credential in code, tests, fixtures, or docs
- [ ] Tests updated per [development.md](development.md#testing), including the negative cases
- [ ] If the change weakens any table above → ADR, not a code comment

## Known accepted risks (revisit yearly at handover)

1. No MFA for email+password `*:ADMIN` accounts — committed for v2 as passkeys-first ([roadmap R2](roadmap.md)).
2. 15-minute revocation window on privileged surfaces; up to 30-day window on unprivileged reads for a demoted-but-not-force-logged-out user.
3. Shared seal secret across workers (see threat model).
4. Consumer-app XSS ≈ session abuse for that user across the estate.
5. D1 backups are weekly — up to a week of account changes lost in the worst restore case.
