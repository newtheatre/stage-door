# ADR-0022: Register never seals a session

**Status:** Accepted · **Date:** 2026-08-19 · **Deciders:** Matt Adcock (ITM 26/27) · Restores the claiming story in [ADR-0007](0007-shadow-accounts-central.md) · Removes the exception noted in [ADR-0013](0013-magic-links-and-the-mfa-seam.md)

## Context

`POST /api/auth/register` classified any row with `password IS NULL AND google_sub IS NULL` as an unclaimed shadow account, wrote the caller's password onto it, and sealed a session. Four problems followed from that one shape, all found in the repository-wide review of 2026-08-19 (#45, #46, #47, #48).

The discriminator is not specific to shadow accounts. `POST /api/users` creates admin-invited accounts with the same shape, and inserts their role grants before the invitee has done anything. Anyone who knew such an address could register with it and receive a session carrying those grants. Reproduced locally: the session came back holding `proscenium:ADMIN` and `rooms:ADMIN`, with no email round-trip anywhere in the flow.

The same path was the only login entry point that never checked `disabled`, so a disabled account could be re-claimed and handed a live estate-wide session. It called `sealLoginSession` directly rather than `sealOrChallenge`, so a passkey enrolled by a shadow-account holder who had signed in by magic link was bypassed. And because it sealed a session only when the address was free or claimable, the presence of `Set-Cookie` answered "does this address have a full account?" for anyone who asked, which is the enumeration signal invariant 8 exists to prevent.

Patching the discriminator would have addressed the first problem only. The common cause is that register performed a privileged act, establishing a signed-in identity, on the strength of an unverified claim to an address.

## Decision

**Register never seals a session, on any path.** It has three outcomes, all returning `{ ok: true }` with no `Set-Cookie`:

- **Address is free.** Create the account with the given password, send a verification email. The caller signs in afterwards with the password they just chose.
- **Address belongs to a claimable row** (no password, no `google_sub`, not disabled). Write nothing. Send a set-password link, the same `password_resets` token an admin-created account gets. Redeeming it runs `POST /api/auth/password/reset`, which already checks `disabled` and routes through `sealOrChallenge`.
- **Address belongs to a full or disabled account.** Write nothing, seal nothing. A full account gets the "you already have an account" notice; a disabled one gets nothing.

`hashPassword` runs before the branch on every path, so scrypt is not a timing oracle either. A `register:acct` rate limit joins the existing `register:ip` one, matching login, forgot and magic-link.

## Alternatives considered

- **A `shadow` column, set by `POST /api/users/shadow` and cleared on claim.** Honest about what the discriminator means, and would have kept the instant guest claim. Lost because it needs a migration and a backfill whose correctness depends on inferring intent for existing rows, and because it closes only the first problem: the disabled check, the seam bypass and the `Set-Cookie` oracle would each still need their own fix.
- **Refuse to claim any row holding grants.** Smallest change. Lost because an invited account is claimable in the window before its grants are inserted, and it leaves the other three problems untouched.
- **Keep sealing, but route the claim through `sealOrChallenge`.** Fixes the seam bypass alone. Lost because it still writes a credential onto someone else's account on an unproven address.

## Consequences

Good: no path from an unverified address to a session, so the class is closed rather than the instance. The claim is once again "just forgot-password", which is what ADR-0007 said it was. ADR-0013's "register (no factors possible) correctly stay outside [the seam]" becomes true for a better reason: register no longer establishes a session at all, so there is nothing for a seam to guard. All three outcomes are byte-identical to an unauthenticated caller.

Bad: registering no longer signs you in. A new user verifies, then signs in; a guest claiming a booking history clicks a link, then sets a password. That is one more step than before for the honest case, and the copy on `/check-email` and the set-password email carries the explanation.

The set-password link reuses `sendPasswordResetEmail`, so a guest claiming an account sees "Reset your password" for an account that never had one. `POST /api/users` has always had the same wording for admin-invited accounts, so this is a pre-existing rough edge and not a new one; a dedicated claim template is worth doing when someone next touches that copy.
