# Architecture Decision Records

Why the service is the way it is. One decision per file, numbered, never edited after acceptance — supersede instead (new ADR, link both ways). When you're about to ask "why on earth…", the answer should be here; if it isn't, that's a missing ADR — write it.

| # | Decision | Status |
|---|---|---|
| [0001](0001-extend-nuxt-auth-utils.md) | Build on nuxt-auth-utils rather than Better Auth / OpenAuth | Accepted |
| [0002](0002-standalone-service.md) | Standalone service at auth.newtheatre.org.uk | Accepted |
| [0003](0003-shared-sealed-cookie-sessions.md) | SSO via shared sealed cookie on `.newtheatre.org.uk` | Accepted |
| [0004](0004-scoped-role-strings.md) | Roles as scoped strings, authorisation stays in apps | Accepted — partially superseded by [0011](0011-role-definitions-and-expiry.md) (definitions + expiry), [0014](0014-grants-require-definitions.md) (free-text granting removed; strings survive) and [0017](0017-app-registry.md) (the no-app-registry stance) |
| [0005](0005-workspace-only-google-sso.md) | Google SSO restricted to the Workspace domain | Accepted |
| [0006](0006-merge-migration-keeping-hashes.md) | One-off user merge keeping scrypt hashes | Accepted |
| [0007](0007-shadow-accounts-central.md) | Guest/shadow accounts live in the central identity store | Accepted |
| [0008](0008-anonymise-not-delete.md) | Erasure = anonymisation, not deletion | Accepted |
| [0009](0009-d1-backed-rate-limiting.md) | Rate limiting via D1-backed fixed-window counters | Accepted |
| [0010](0010-legacy-roles-dormant-namespace.md) | Legacy-import roles land in a dormant `ticketing:*` namespace | Accepted |
| [0011](0011-role-definitions-and-expiry.md) | Role definitions and grant expiry (roles v2) | Accepted — partially superseded by [0014](0014-grants-require-definitions.md) (registry now mandatory for new grants) |
| [0012](0012-sso-only-workspace-and-mfa.md) | Workspace addresses are SSO-only; MFA (passkeys + TOTP) for the residual privileged accounts | Accepted |
| [0013](0013-magic-links-and-the-mfa-seam.md) | Magic-link sign-in; one MFA seam for every password-equivalent entry point; emailed tokens hashed at rest | Accepted |
| [0014](0014-grants-require-definitions.md) | New grants must reference a role definition; free-text granting removed | Accepted |
| [0015](0015-account-merge.md) | Account merge: winner absorbs loser, app hooks first, loser erased | Accepted |
| [0016](0016-estate-secrets-in-secrets-store.md) | Estate-wide secrets live in the Cloudflare Secrets Store, bound per worker | Accepted |
| [0017](0017-app-registry.md) | The estate's apps live in a database registry, not in code | Accepted |

## Template

```md
# ADR-NNNN: Title

**Status:** Proposed | Accepted | Superseded by ADR-MMMM · **Date:** YYYY-MM-DD · **Deciders:** …

## Context
What situation forced a decision, and what constraints applied.

## Decision
What we chose, stated as a fact.

## Alternatives considered
Each with the honest reason it lost.

## Consequences
Good, bad, and the things we now must do because of this.
```
