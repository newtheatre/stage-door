# CLAUDE.md — working on newtheatre/stage-door

Guidance for Claude Code sessions in this repo. A human (usually the NNT IT Manager) reviews everything; write code and docs they can hand to a successor.

## What this is

The central identity service for `*.newtheatre.org.uk`. Every app in the estate trusts the session cookie this service writes. **A bug here is a bug in every app at once** — bias towards small, reviewable changes and say so plainly when a request has estate-wide blast radius.

## Commands

```bash
bun install            # deps (Bun is the package manager — do not use npm/yarn)
bun run dev            # local dev server on :3000
bun run db:migrate     # apply Drizzle migrations locally
bun run db:generate    # generate a migration from schema changes (review the SQL!)
bun run db:seed        # dev-only seed; prints generated credentials, commits none
bun run test           # unit + integration (vitest)
bun run lint           # eslint (matches Proscenium's config)
bun run typecheck      # nuxi typecheck
npx wrangler d1 ...    # production D1 — read docs/operations.md before touching
```

## Source of truth & docs discipline

- These docs were written **before the code** (spec-first), and the estate cut over on 2026-08-12 — so the inversion is now in force: **code is truth and docs must follow it**. A PR that changes behaviour updates the matching doc in the same PR; where you find drift, fix the doc to match the code (and flag it if the code looks wrong).
- **Any PR that changes behaviour updates the matching doc in the same PR.** Schema → `docs/data-model.md`; endpoints → `docs/api-reference.md`; session shape → `docs/session-contract.md` (and bump its version header); anything an operator does → `docs/operations.md`.
- New architectural choice, or reversing an old one → add an ADR in `docs/decisions/` (template in that folder's README). Never edit an accepted ADR's decision; supersede it.

## Invariants — do not break these

1. **Only this service writes the session.** Consumer apps call `getUserSession()`/`requireUserSession()` read-only. Never suggest an app call `setUserSession()` (single temporary exception documented in `docs/integrating-an-app.md` §guest-checkout).
2. **The session shape is a published contract** (`docs/session-contract.md`). Additive changes only; removals/renames need an ADR and a coordinated release of every consumer app.
3. **Canonical user IDs are stable forever.** Never regenerate, reuse, or change a `users.id` — app databases FK against them (Proscenium `reservations.user_id` is NOT NULL/`restrict`).
4. **Erasure is anonymisation, never row deletion** (`docs/gdpr-retention.md`). Booking/sales statistics must survive user erasure.
5. **Google sign-in requires `hd === 'newtheatre.org.uk'` and `email_verified === true`, checked server-side** in the OAuth success handler. The `authorizationParams.hd` hint is cosmetic only.
6. **Redirect targets validated** against `^https://([a-z0-9-]+\.)?newtheatre\.org\.uk(/|$)` — anything else falls back to the apex. No open redirects, ever.
7. **Secrets never in code, config defaults, fixtures, or docs.** Service tokens live in worker secrets; secrets shared across workers (`NUXT_SESSION_PASSWORD`) live in the account Secrets Store and are bound in via `secrets_store_secrets` (ADR-0016) — store *ids* and binding names are config, not secrets, and are committed. Everything is mirrored in the committee password manager, which is the only place a value can be read back. Seed scripts generate random credentials at runtime and print them.
8. **Enumeration-safe responses** on register / forgot-password / resend-verification: identical response whether or not the account exists.
9. **Password hashes are scrypt PHC strings** via nuxt-auth-utils' auto-imported `hashPassword`/`verifyPassword`. No other hashing, no manual crypto.
10. **Service-token endpoints** (`/api/users/shadow`, hook callers) authenticate via `Authorization: Bearer` checked against **hashed** tokens in `service_tokens`. Constant-time compare.

## Repo conventions

- Drizzle schema in `server/db/schema/`, one file per domain area; migrations generated, then hand-reviewed — D1 is SQLite, no `ALTER COLUMN`.
- Zod for every request body/query (`server/utils/validation.ts`), same style as Proscenium.
- Server handlers: one route = one file under `server/api/` (Nitro conventions). Auth pages under `app/pages/`, `@nuxt/ui` components.
- Shared session types + `hasRole`/`hasAnyRole` helpers are defined in `packages/auth-types` and published as `@newtheatre/auth-types` on GitHub Packages ([ADR-0025](docs/decisions/0025-publish-auth-types-as-a-package.md)). This app consumes its own package via `workspace:*`; the three consumer apps install the published version. Change the source, bump its version, merge: the publish workflow does the rest. Never redeclare the contract inline in a consumer.
- Errors: `createError({ statusCode, statusMessage })`; no stack traces or internal detail in responses.
- Tests: every auth-flow change needs a test that fails without the change (login, refresh staleness, epoch bump, redirect allowlist, hd rejection are the high-value suites).
- British English in UI copy and docs.

## Comments

Enforced by `bun run check:comments`, which CI runs. There are no exemptions.

1. **Two lines of text, maximum.** Delimiters do not count. Most comments should
   be a few words. Past two lines you are writing a doc, not a comment.
2. **Route headers are one line: what it does.** The method and path are the
   filename, and the auth is the guard on the line below.
3. **No JSDoc block tags.** No `@param`, `@returns`, `@props`, `@emits`,
   `@route`, `@example`. The signature and the types already say it.
4. **No narrated history.** Not "used to", "originally", "an earlier version".
   The rule is a comment; the incident that taught it is an ADR.
5. **No figures a comment cannot keep true.** Row counts and percentages go in
   `docs/`, dated, where something updates them.

Anything that does not fit has somewhere to go:

| What it is | Where it goes |
| --- | --- |
| A reason that needs a paragraph | an ADR in `docs/decisions/` |
| An enum, a lifecycle, a column list | `docs/` — the data model or API reference |
| An endpoint's full contract | `docs/` — the API reference |
| A trap that would cost someone an evening | an ADR, cited from a one-line comment |

The comment then states the constraint and cites where the argument lives:
```
// MUST NOT throw — authorize() would run the handler unchecked (ADR-0008).
```

## Things Claude Code should proactively flag

- Any change that would require rotating `NUXT_SESSION_PASSWORD` (it logs out the entire estate).
- Any new endpoint lacking rate limiting or audit logging where peers have it.
- Any consumer-app PR (Proscenium/rooms) that reintroduces local credential storage or role editing.
- Drift between `docs/api-reference.md` and actual routes (cheap to check, expensive to discover late).
- A comment over two lines — see §Comments; `bun run check:comments` catches it.
