# ADR-0012: Workspace addresses are SSO-only, and MFA for the residual privileged accounts

**Status:** Accepted · **Date:** 2026-08-13 · **Deciders:** Matt Adcock (ITM 26/27) · Closes accepted risk #1 in [security.md](../security.md) · Builds on [ADR-0005](0005-workspace-only-google-sso.md)

## Context

v1 shipped with a known gap: an `*:ADMIN` account signing in with email and password had no second factor, so one phished or reused password was full admin access to every app in the estate. The roadmap committed to "passkeys first" and flagged that the scope needed deciding at pickup.

Looking at production reframed the problem. Of the ten live privileged grants, **nine were on password-only accounts**, and six of those were `@newtheatre.org.uk` addresses that had simply never linked Google: `theatremanager@`, `studio@`, `engagement@`, `secretary@`, `president@`. These are handed-over role addresses: the password lives in the committee password manager and moves to the next holder each year.

So the cheapest large win was not MFA. It was getting Workspace addresses onto Google, which inherits Workspace's enforced 2SV for free. That also lines up with the Workspace restructure for the new committee year, in which role addresses become **groups** and every committee member gets a personal account.

## Decision

**1. `@newtheatre.org.uk` addresses cannot use password login at all.** The rule is a property of the address, applied at three entry points that must move together or it is bypassable: login refuses with a `403`, and forgot-password and register silently no-op (keeping their enumeration-safe `{ ok: true }`) so a reset can't re-establish a password. `POST /api/users/:id/clear-password` lets an admin null the password once Google is linked, so the rule is enforced by data as well as by code.

Login's 403 is **deliberately non-generic**, "NNT accounts sign in with Google", and is the single exception to enumeration-safe login errors. The domain policy is a public fact about the *address*, not a fact about whether an account exists, and a generic "invalid email or password" would strand committee members with no idea why their password stopped working. Enforcement is immediate: affected accounts are picked up on their next sign-in, because Google's email-match linking (`resolveGoogleUser`, precedence `google_sub` → `pending_google_email` → email) attaches the existing account and all its history automatically.

**2. MFA covers the residual**: accounts that genuinely cannot use Workspace SSO (the ITM's personal address, the SU account). **Both passkeys and TOTP**, because they suit different accounts: a passkey is right for a personal device, and TOTP is right for a shared account whose seed lives in the password manager and hands over annually. Recovery codes back both up.

**3. Mandatory for `*:ADMIN`, opt-in for everyone else.** The rule is a property of the *account*, not the session, which is what lets the session contract stay unchanged:

> `mfaRequired` = holds any `:ADMIN` role (active grants only, via `activeRoleCondition`) **and** `password IS NOT NULL`.

A Google-only account is exempt (Workspace enforces 2SV upstream). An account with *both* a password and Google is not, because the password remains an attack path.

**4. The enrolment gap resolves towards availability, not lockout.** A required-but-unenrolled admin still gets a session at login, they gave the right password, and locking the ITM out of their own account is worse than the gap, but `requireAuthAdmin` returns `403 { mfaEnrolmentRequired: true }` until they enrol. They keep their account; they lose admin powers until they finish.

**5. Role accounts are re-granted to personal accounts and then disabled**, with two dashboard hints so none are missed: "NNT addresses still holding a password" and "admins without a second factor", each a one-click filter.

### Implementation notes worth keeping

- **A passkey is a complete login, not a second step.** Possession plus the user verification we require is already two factors, and it is phishing-resistant in a way TOTP is not. `/api/webauthn/authenticate` therefore seals a session by itself, and the challenge screen offers it as an alternative to typing a code. Registration demands `residentKey: 'required'` so authentication can be **usernameless**: nothing there answers "does this address have a passkey?" for an unauthenticated caller.
- **TOTP is hand-rolled** (RFC 6238 over Web Crypto, ~60 lines) rather than taken as a dependency: Workers-native, no Node shims, and asserted directly against the RFC's published test vectors. `last_used_step` blocks replay of a code inside its own validity window.
- **Recovery codes are SHA-256 at rest, plaintext shown once**: the same treatment as service tokens. CLAUDE.md invariant 9 ("scrypt PHC, no other hashing") is scoped to *passwords*; these are high-entropy secrets, and eight scrypt verifications per attempt would be costly on a Worker.
- **Pending logins and WebAuthn challenges live in a D1 table** (`mfa_challenges`), not `useStorage()` or a cookie. KV is disabled on this worker, so `useStorage()` would be per-isolate and silently lose challenges between requests; and a second sealed cookie inherits `cookie.domain` via defu, broadcasting a half-authenticated cookie across the whole estate.
- **nuxt-auth-utils' WebAuthn handlers have three traps**, all confirmed in its source: `storeChallenge`/`getChallenge` are an all-or-nothing typed pair, and omitting them verifies against `expectedChallenge: ''`: replay protection off; `requireUserVerification: false` is hardcoded, so `userVerified` is asserted in our own `onSuccess`; and `getOptions` must return a stable `userID`, or SimpleWebAuthn v11 generates a random one per call and the passkey never identifies the account.
- `rpID` defaults to the request hostname, so localhost and production passkeys are not interchangeable. Documented in [development.md](../development.md) rather than fought.

## Alternatives considered

- **MFA for everyone with a role, immediately**: rejected: most of the privileged set was about to move to Google anyway, and mandating TOTP on accounts that were days from becoming SSO-only is churn the committee would have felt.
- **TOTP only** (no passkeys): rejected: passkeys are the phishing-resistant option and the one the ITM will actually use daily.
- **Passkeys only**: rejected: a shared committee account can't hand over a platform authenticator, but it can hand over a TOTP seed in the password manager.
- **MFA state in the session** (`mfaVerified: true`): rejected: it would change the published session contract and force every consumer app to a coordinated release, for a check that only this service ever makes.
- **A second sealed cookie for the pending login**: rejected for the `cookie.domain` inheritance above.
- **A gradual "enforce from date X"**: rejected: with SSO carrying most of the estate, the residual set is two accounts, and the enrolment gap (session yes, admin no) is already a soft landing.

## Consequences

Good: the phished-password path into estate-wide admin is closed; committee handover of a role address stops meaning "hand over a password"; passkey sign-in is faster than what it replaces; the audit log gains `mfa.*` events; factor state is in the subject-access export and cleared on erasure.

Bad: an admin who loses both their phone and their recovery codes now needs another admin to run `POST /api/users/:id/mfa-reset`, and for `auth:ADMIN` there may be no one else, so the ITM's recovery codes belong in the committee password manager *before* enrolment ([operations.md](../operations.md)). `@simplewebauthn/server@11` is pinned (v13 drops `@simplewebauthn/types`, which the module's own types import) and its top-level re-export of `cross-fetch` needs a rollup stub, or the Worker bundle drags in `node-fetch@2` and `node:http`. Passkeys registered against `localhost` don't work in production and vice versa.
