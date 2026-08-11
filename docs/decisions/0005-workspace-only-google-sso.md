# ADR-0005: Google SSO restricted to the Workspace domain

**Status:** Accepted · **Date:** 2026-08-09 · **Deciders:** Matt Adcock (ITM 26/27)

## Context

Two user populations: members/committee (who hold or can hold `newtheatre.org.uk` Workspace accounts, with 2SV enforced by Workspace policy) and the general public (audience members who book tickets, external room hirers). Google sign-in could be offered to everyone or only to the Workspace domain.

## Decision

The Google button accepts only `newtheatre.org.uk` accounts: the OAuth request sends `hd=newtheatre.org.uk` as a UX hint, and the success handler **rejects server-side** unless the profile's `hd` claim is exactly `newtheatre.org.uk` and `email_verified` is true. Everyone else uses email+password. Accounts link by stable `google_sub` after first sign-in; the first sign-in matches an existing user by lowercased email (claiming shadow accounts included) or creates a new verified user.

## Alternatives considered

- **Any Google account, linked by verified email** — friendlier for the public; lost because it adds account-linking edge cases (unverified emails, changed emails, one person with several Google identities) to build and test, for users who already have a working email+password path. Can be revisited without schema change — `google_sub` doesn't care which domain it came from.

## Consequences

Good: clean mapping to the account model (Workspace = SSO, public = password); Workspace's 2SV becomes the effective MFA for the accounts that matter most; removing someone from Workspace (leaver process) removes their SSO automatically. Bad: members who prefer personal Gmail must use a password; the friendly rejection page must exist and point somewhere useful. The `hd` server-side check is a security invariant (CLAUDE.md #5) — the authorization parameter alone is spoofable.
