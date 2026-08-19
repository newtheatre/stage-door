# ADR-0016: Estate-wide secrets live in the Cloudflare Secrets Store

**Status:** Accepted · **Date:** 2026-08-14 · **Deciders:** IT Manager

## Context

`NUXT_SESSION_PASSWORD` is one value shared by four workers (auth, proscenium,
room-bookings, rehearsal): that is what makes the shared sealed cookie of
[ADR-0003](0003-shared-sealed-cookie-sessions.md) work at all. Held as a plain
worker secret it was stored four times, which meant a rotation was four
`wrangler secret put` calls plus four redeploys, with every user on the estate
logged out for the window between the first worker and the last. The runbook
said "do them within minutes of each other" because there was no way to make it
atomic. Nothing enforced that the four copies actually matched; a typo in one
would present as "sessions work everywhere except rooms", which is a genuinely
horrible thing to debug.

Cloudflare's Secrets Store holds account-level secrets that workers reference by
binding, so the value exists once and each worker points at it.

## Decision

Secrets shared by more than one worker live in the account Secrets Store
(`default_secrets_store`, `fdfe08b6b01f498fbddbc08c2891cadb`) and are bound into
each worker via `secrets_store_secrets` in `nitro.cloudflare.wrangler`. Secrets
used by exactly one worker stay plain worker secrets.

Because a Secrets Store binding is an object with an async `get()` rather than a
string, each app carries `server/plugins/0.secrets-store.ts`, which reads the
binding on Nitro's `request` hook and writes the value into
`runtimeConfig.session.password` before any handler runs.

**The binding is named `SESSION_PASSWORD`, not `NUXT_SESSION_PASSWORD`.** On
Workers `process.env` is a proxy over the bindings object and Nitro's `applyEnv`
copies any `NUXT_*` key onto the matching runtimeConfig path, so a
NUXT_-prefixed binding would put the *binding object* where the password belongs
and break sealing everywhere at once. The secret keeps its `NUXT_` name inside
the store; only the binding drops the prefix.

## Alternatives considered

**Leave them as four worker secrets.** Works, and is one fewer moving part, but
keeps the rotation footgun and the silent-drift failure mode described above.
Rejected once the estate reached four consumers; at two it would have been a
reasonable call.

**Fetch the secret at call time everywhere instead of hydrating runtimeConfig.**
Honest about the async nature of the binding, but impossible for the session
password specifically: nuxt-auth-utils reads `runtimeConfig.session.password`
synchronously from inside its own module and memoises it. We would have had to
fork or patch it.

**Name the binding `NUXT_SESSION_PASSWORD` so it flows through Nitro's env
mapping unaided.** This was the first thing tried in spirit and it is a trap.
see the Decision above. Recorded here because it looks correct and is not.

## Consequences

- Rotation is one write to the store. Workers pick the new value up as their
  isolates recycle, so the estate converges on its own rather than by a
  stopwatch. There is a window during which some isolates hold the old value and
  some the new; users caught by it see one logout, which is the same cost the
  old procedure imposed deliberately.
- Reading a secret is an async call on the first request an isolate serves.
  Memoised per isolate, so the cost is not per request.
- Local dev is unchanged: no binding exists, the plugin no-ops, and the password
  comes from `.env` as `docs/development.md` describes. This also means the
  binding is only exercised in production: a mistake in it cannot be caught
  locally, only by deploying.
- Scheduled tasks do not run the `request` hook. None of ours seal sessions
  today; one that needs a store-backed secret must read the binding itself.
- Anyone with Cloudflare dashboard access can now see the *existence* of estate
  secrets in one list. Values are still write-only: the store cannot read a
  secret back out, which also means **the password manager remains the only
  place a value can be recovered from**. Losing the password-manager entry now
  means rotating, not looking it up.
- `secrets_store_secrets` is missing from the wrangler types Nitro 2.13 bundles,
  so each `nuxt.config.ts` carries a cast with a note to remove it later.
