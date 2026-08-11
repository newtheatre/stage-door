# Stage Door — NNT Auth Service

Single sign-on and identity for the Nottingham New Theatre's web estate (`*.newtheatre.org.uk`). One account per person, shared across [Proscenium](https://github.com/newtheatre/proscenium) (main site + box office), [rooms](https://github.com/newtheatre/rooms) (room booking), the planned photos platform, and any future app.

**Live at:** `https://auth.newtheatre.org.uk` · **Owner:** IT Manager / Archivist · **Status:** spec-first — these docs were written before the code and are the source of truth during the build. Where code and docs disagree during implementation, the docs win until a documented decision says otherwise.

## What it does

- **Google SSO** for `newtheatre.org.uk` Workspace accounts (members, committee, alumni).
- **Email + password** for everyone else — most audience members only ever book tickets and will never have a Workspace account.
- **Guest ("shadow") accounts** so ticket booking never requires registration.
- One hosted login/register/reset/account UI; consumer apps delete theirs.
- Central roles (`proscenium:ADMIN`, `rooms:ADMIN`, …) with an admin UI for the ITM.
- Verification, password reset, audit logging, rate limiting — built once, not per app.

## How it works in one paragraph

Every app already uses [`nuxt-auth-utils`](https://github.com/atinux/nuxt-auth-utils) stateless **sealed-cookie sessions**. This service is the only writer of that session; the cookie is scoped to `.newtheatre.org.uk` and sealed with a secret shared by all workers, so every app on a subdomain reads the login locally with `getUserSession()` — no network call, no OAuth dance between our own apps. Details: [docs/architecture.md](docs/architecture.md), rationale: [ADR-0003](docs/decisions/0003-shared-sealed-cookie-sessions.md).

## Quick start (development)

```bash
git clone https://github.com/newtheatre/stage-door && cd stage-door
bun install
cp .env.example .env      # fill in per docs/development.md
bun run db:migrate        # local SQLite
bun run dev               # http://localhost:3000
```

First success in under five minutes: `bun run db:seed` creates a dev admin (credentials printed to the console, never committed), log in at `/login`, open `/admin`. Full local-dev story — including how cookie-domain sharing works *without* subdomains on localhost — in [docs/development.md](docs/development.md).

## Documentation map

| Doc | Read it when… |
|---|---|
| [docs/architecture.md](docs/architecture.md) | you want the system in your head: components, flows, trust boundaries |
| [docs/session-contract.md](docs/session-contract.md) | you're touching anything that reads or writes the session — **the contract both sides compile against** |
| [docs/data-model.md](docs/data-model.md) | you're changing the schema |
| [docs/api-reference.md](docs/api-reference.md) | you're calling or changing an endpoint |
| [docs/integrating-an-app.md](docs/integrating-an-app.md) | **you're adding a new app to the estate** — the piggyback guide |
| [docs/development.md](docs/development.md) | you're setting up locally or writing tests |
| [docs/operations.md](docs/operations.md) | something is on fire, or you're rotating secrets / issuing service tokens |
| [docs/security.md](docs/security.md) | you're reviewing a change that touches auth logic (most of them) |
| [docs/gdpr-retention.md](docs/gdpr-retention.md) | erasure, subject access, the inactivity sweep (Phase 7) |
| [docs/migration.md](docs/migration.md) | the one-off Proscenium + rooms user merge (historical after cutover) |
| [docs/roadmap.md](docs/roadmap.md) | future work: roles v2 (configurable + expiry), MFA, candidate features |
| [docs/decisions/](docs/decisions/) | you're about to ask "why on earth is it done this way?" |
| [CLAUDE.md](CLAUDE.md) | you are Claude Code (or pairing with it) |

## Stack

Nuxt 4 · `nuxt-auth-utils` · Drizzle + Cloudflare D1 (via `@nuxthub/core`) · Resend (email) · Cloudflare Workers (`cloudflare_module` preset) · Bun. Deliberately identical to Proscenium's stack — see [ADR-0001](docs/decisions/0001-extend-nuxt-auth-utils.md).

## Contributing

Small estate, small team: work on a branch, open a PR, and every PR that changes behaviour must update the relevant doc in the same PR (CI-enforced honour system; see CLAUDE.md). The audit + migration history and the original implementation plan live in the NNT Claude project ("NNT Auth Service Plan").
