# Development

Local setup, the localhost cookie story, testing, and conventions for day-to-day work (human or Claude Code).

## Prerequisites

Bun ≥ 1.2, Node 20+ (for tooling), wrangler (authenticated only if you need production D1 — most work doesn't). No Cloudflare account needed for local dev: NuxtHub/Nitro run D1 as local SQLite.

## Setup

```bash
git clone https://github.com/newtheatre/stage-door && cd stage-door
bun install
cp .env.example .env
bun run db:migrate
bun run db:seed        # dev admin + sample users; credentials PRINTED, random each time
bun run dev            # http://localhost:3000
```

`.env` keys (never commit `.env`):

| Key | Dev value |
|---|---|
| `NUXT_SESSION_PASSWORD` | any 32+ char string (nuxt-auth-utils generates one into `.env` on first dev run if the key is **absent** — an empty value does not trigger generation and breaks session sealing, so `.env.example` ships it commented out) |
| `NUXT_RESEND_API_KEY` | leave unset — dev mode logs emails to the console instead of sending |
| `NUXT_OAUTH_GOOGLE_CLIENT_ID` / `_CLIENT_SECRET` | the **dev** OAuth client (redirect URI `http://localhost:3000/auth/google`) — see below |

## The localhost cookie story

Production sets `cookie.domain = '.newtheatre.org.uk'`; localhost has no subdomains, so dev config **omits the domain** (host-only cookie). Consequences:

- Running the auth service alone: everything just works on `localhost:3000`.
- Running the auth service **plus a consumer app** locally (e.g. auth on `:3000`, Proscenium on `:3001`): host-only cookies don't cross ports' hostnames — they do share `localhost`, so this works as long as both use the same cookie name and secret. Set the same `NUXT_SESSION_PASSWORD` in both `.env` files and log in via the auth service; the consumer app on another port will read the session. (Same host = same cookie jar; the port is irrelevant to cookies.)
- Consumer-app-only development (most app work): you don't need the auth service running at all. Use the app's dev seed, which creates a session via a **dev-only** login route guarded by `import.meta.dev` — that route is the single sanctioned exception to the "apps never write sessions" rule and must not exist in production builds.

## Passkeys in dev

WebAuthn needs a secure context; `http://localhost:3000` counts, so passkeys work locally with no extra setup. But `rpID` defaults to the request hostname, so **a passkey registered on localhost is not usable on `auth.newtheatre.org.uk`, and vice versa** — that is the spec working as intended, not a bug to fix. Chrome DevTools → More tools → WebAuthn → "Enable virtual authenticator environment" gives you a fake authenticator (set "Supports resident keys" and "Supports user verification" — the service requires both) so you can test enrolment and sign-in without touching real hardware.

TOTP needs nothing special: enrol at `/account`, scan the QR with any authenticator app, or paste the shown key into it.

## Google OAuth in dev

A separate "NNT Auth (dev)" OAuth client exists in the Workspace Google Cloud project with `http://localhost:3000/auth/google` **and** `http://localhost:3000/auth/google-link` (the /account "Connect Google" flow) as authorised redirect URIs — the production client needs the same pair on `https://auth.newtheatre.org.uk`. The `hd` check still applies — you need a `newtheatre.org.uk` account to test SSO. For non-Workspace flows, test with email+password; for the rejection page, any personal Google account demonstrates it.

## Testing

```bash
bun run test           # vitest: unit + integration (h3 app, in-memory SQLite)
bun run test:e2e       # optional: playwright against the dev server
```

High-value suites (keep these green and comprehensive — they encode the security posture):

- **Login**: success, wrong password, unknown user, guest account, disabled account — the last four must produce byte-identical responses.
- **Registration**: new user; shadow-claim path; existing-full-account enumeration safety.
- **Google handler**: `hd` missing / wrong / correct; `email_verified` false; `google_sub` linking vs email matching precedence.
- **Refresh**: fresh session passes; stale epoch rejected; disabled user rejected; roles re-read.
- **Redirect allowlist**: table-driven — subdomains pass; apex passes; `evil-newtheatre.org.uk`, `newtheatre.org.uk.evil.com`, `javascript:`, `//` all fall back to apex.
- **Service tokens**: valid, invalid, missing; constant-time compare (assert via implementation, not timing).
- **Rate limits**: window rollover, per-IP vs per-account independence.

Every PR that changes an auth flow adds/updates a test that fails without the change (CLAUDE.md).

## Seeds

Seed addresses use `@dev.newtheatre.org.uk`. They must **not** use a reserved TLD (`.test`, `.invalid`, `example.com`): those are exactly what `isUndeliverableEmail` treats as anonymised placeholders, so seeded users would be hidden from `/admin` and blocked from register/reset — the dev environment would silently diverge from production (#16).

`bun run db:seed` is dev-only and **generates random credentials at runtime, printing them once**. It must refuse to run when `NODE_ENV=production` or when the D1 binding is remote. (Lesson inherited from Proscenium, whose seed created five known-password admin accounts — those were excluded at migration and the pattern must not recur.)

## Working with Claude Code

Read `CLAUDE.md` first — it carries the invariants and the docs-discipline rules. Practical habits that work well in this repo:

- Point Claude Code at the relevant doc *section* in the prompt ("implement `/api/session/refresh` per docs/api-reference.md and session-contract.md") rather than re-describing behaviour — the docs are the spec.
- Ask it to write the failing test first for auth-flow changes; the test suites above are the skeleton.
- Anything touching invariants 1–10 in CLAUDE.md deserves a human read of the diff, not a skim.
- When Claude Code flags a docs/code divergence, resolve it in the same PR (fix the code pre-cutover, fix the doc post-cutover) — divergence is the one state these docs must never be left in.
