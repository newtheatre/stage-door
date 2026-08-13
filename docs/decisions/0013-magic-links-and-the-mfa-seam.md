# ADR-0013: Magic-link sign-in, and one seam for every password-equivalent entry point

**Status:** Accepted · **Date:** 2026-08-14 · **Deciders:** Matt Adcock (ITM 26/27), implemented with Claude Code · Graduates roadmap R4's passwordless item · Extends [ADR-0012](0012-sso-only-workspace-and-mfa.md)

## Context

Two things arrived together. First, the request: an emailed sign-in link as an alternative to passwords — roadmap R4 had already called passwordless "probably the highest-value item in this list for actual users", because the audience population books tickets twice a year and forgets passwords in between. Second, a finding from the design review that shaped how it had to be built: **password reset was already an MFA bypass**. `reset.post.ts` sealed a full session on token consumption without ever consulting `enrolledFactors` — mailbox control alone defeated the second factor ADR-0012 had just introduced, and it even bumped the session epoch first, killing the legitimate user's sessions while handing the attacker a fresh one.

A magic link is structurally identical to a password reset (consume emailed token → session), so building it by copying that file would have shipped the same hole a second time, in a feature whose entire premise is "the mailbox is the credential".

## Decision

**1. One seam: `sealOrChallenge(event, user)`** (`server/utils/mfa.ts`). Every password-equivalent entry point routes through it: password login, password reset, magic-link verify. Enrolled factors → a pending `mfa_challenges` attempt and `{ mfaRequired, attemptId, methods }`, never a session; no factors → `sealLoginSession`. The rule is now impossible to forget per-endpoint, and the reset bypass is closed: a reset still changes the password (that part *is* mailbox-trust, unchanged since v1) but the second factor still gates the session. Google (Workspace 2SV upstream), WebAuthn (the passkey is the factor), and register (no factors possible) correctly stay outside it.

**2. Magic links** — `POST /api/auth/magic-link/request` + `/verify`, a `magic_links` table, a 15-minute single-use token, one outstanding per user:

- **A link, not an emailed 6-digit code.** The roadmap sketched both; the link wins on this population: one tap from the email on the phone where the email arrives, no transcription, and the expiry can be short because nobody is typing anything. The OTP variant remains unbuilt, not rejected — it would slot into the same seam if a use case appears.
- **Shadow accounts included.** Mailbox control is exactly the trust the reset-claim path already extends, and passwordless bookers are the point of the feature. The session keeps `guest: true`; nothing is claimed and no password is created.
- **Consuming a link verifies the address** (`verified: true`) — the same precedent as Google email-match: the mailbox was just proven.
- **Workspace addresses get the deliberate `403 { useGoogle: true }`** at request time, the same single exception to enumeration-safety as password login (ADR-0012): a magic link is a login entry point, and a committee member silently never receiving one is a support ticket, not a security property.
- **No epoch bump** on consumption — unlike reset, no credential changed; existing sessions have no reason to die.

**3. Emailed tokens are hashed at rest** (`hashLoginToken`, SHA-256). The magic-link table never sees a plaintext token — and while in the file, the same treatment was applied retroactively to `password_resets` and `email_verifications`, which had shipped plaintext (an inconsistency with recovery codes and service tokens rather than a decision). A database leak must not hand out live login links. Deploying invalidated any outstanding reset/verification tokens; they live ≤24 h, so the cost was nil. As with recovery codes: CLAUDE.md invariant 9's scrypt rule is scoped to passwords — these are high-entropy random tokens, and SHA-256 is the right tool.

**4. The challenge UI became a component** (`app/components/MfaChallenge.vue`) because three pages now need it: login, reset-password, magic-link. It also fixed the recovery-code affordance — previously a field labelled "Code", placeholder `123456`, `autocomplete="one-time-code"`, with recovery codes mentioned only in passing prose, which users read as "there is no way to use my backup codes". Now: a six-digit pin input for authenticator codes, an explicit **"Lost your phone? Use a recovery code"** toggle to a dedicated field, and whitespace forgiven server-side alongside case and dashes (a pasted code with a trailing space used to fail silently).

## Alternatives considered

- **Emailed 6-digit OTP instead of a link** — see above; unbuilt, not rejected.
- **Magic link bypasses MFA ("the email already proves identity")** — rejected outright, and explicitly by the requester: mailboxes are the single most-compromised credential store; the factor exists precisely because the mailbox might not be the account holder.
- **Put the factor check inside `sealLoginSession`** — rejected: Google, WebAuthn, and register legitimately seal without a challenge; a seal-side check would need bypass flags, which is how the next bypass gets written. A named seam that password-equivalent callers opt into keeps the exceptions visible.
- **Full accounts only (no shadow accounts)** — rejected: it would gut the feature's value and defends nothing the reset-claim path doesn't already allow.
- **Reuse `password_resets` with a `kind` column** — rejected: different expiry, different consumption semantics (reset rows survive expiry-check failure for the resend flow), and the table is two columns long.

## Consequences

Good: bookers sign in without owning a password; the reset-path bypass is closed with a regression test that fails without the seam; all emailed tokens are hashed at rest; recovery codes are discoverable at the moment they're needed; future entry points (the OTP variant, anything else) inherit MFA correctness by construction.

Bad: an MFA-enrolled user who resets their password now faces a challenge immediately after — correct, but a longer flow than before (the copy explains it). Magic-link email deliverability becomes a login dependency for passwordless users; the login page keeps password and Google paths as first-class alternatives. The request endpoint's Workspace 403 remains a deliberate enumeration exception, now in two places, both documented in [security.md](../security.md).
