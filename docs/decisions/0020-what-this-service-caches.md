# ADR-0020: What this service caches, and what it must never cache

**Status:** Accepted · **Date:** 2026-08-18 · **Deciders:** IT Manager

## Context

Roles v3 added outbound work on a schedule and a handful of new admin reads, and
the question "should we cache heavily?" came with it. This service had no
caching at all: `hub` had `kv: false, cache: false`, and every read was a live
D1 query.

Two things make the obvious answer wrong here.

The traffic is tiny. This is an identity service for a student theatre; the
admin surface is used a few times a term and logins are a few hundred a day. D1
reads are already fast enough that a storage layer would be cost without benefit
for most of what it would hold.

And the thing most worth caching is the thing most dangerous to cache. `loadRoles`
runs on every seal, which makes it the obvious candidate and also the one read
where a stale answer is a privilege decision made on out-of-date information.

## Decision

**Nothing that decides access is cached outside a single request.** That is the
rule; everything below follows from it.

### What is cached

- **Request-scoped reuse, by passing data rather than storing it.**
  `requireAuthAdmin` loads roles once and hands them to `isMfaRequired`, which
  used to re-read them. `enrolledFactors` is one round trip rather than two.
  Both run before every admin request. Passing a value down a call stack has no
  staleness window at all, which is why it is preferred here over a memo.
- **Conditional fetches on manifest sync** (ADR-0018): a stored ETag drives
  `If-None-Match`, and a matching SHA-256 of the body short-circuits
  reconciliation. A daily poll of four apps therefore does almost no work.
- **Short private HTTP caching on admin metadata reads**: role definitions and
  the permission vocabulary at 60 seconds, the app registry at 30. `private`,
  never `public`: these carry member names and holder counts.

### What is not cached, deliberately

- **`loadRoles`, `effectiveRoleCondition`, `requireAuthAdmin`, `loadRoleGrants`.**
  A revoked role must stop working within the 15-minute staleness window of
  ADR-0003 and no longer, and on this service's own admin surface it must stop
  working on the next request.
- **The ADR-0014 definition check in `roles.put.ts`.** A definition created
  seconds ago must be grantable immediately, so it reads D1 every time.
- **Anything behind a guard, via `defineCachedEventHandler`.** A cache hit skips
  the handler, including its authorisation. Proscenium already documents this at
  `server/api/admin/stats.get.ts`, having nearly shipped its finances
  unauthenticated.

### No NuxtHub KV or cache layer

`hub.kv` and `hub.cache` stay `false`, and this is a finding rather than a
preference. This service's bindings come from the hand-managed
`nitro.cloudflare.wrangler` block and it deploys through Workers Builds and
`wrangler deploy`. Enabling `hub.cache` builds cleanly but **emits no KV
namespace binding**, so the cache has no store: it would degrade to per-isolate
memory, unshared and invisible.

That is worse than no cache. A per-isolate store of role data is exactly the
cross-user leak this ADR exists to prevent, and it would present as a cache that
appears to work in development and silently does nothing in production.

If a KV layer is ever genuinely wanted, it needs a namespace created in the
Cloudflare account and a `kv_namespaces` entry added to
`nitro.cloudflare.wrangler` by hand, matching the binding name NuxtHub expects.
That is a deliberate infrastructure change, not a config flag.

## The ban worth writing down

**Never memoise roles at module scope.** A Worker isolate is reused across
requests *and across users*. A `Map` at module scope in `session.ts` would serve
one member's roles to another, would pass every local test, and would be close
to impossible to reproduce from a bug report. Request-scoped only, and prefer
passing the value to storing it.

## Alternatives considered

- **Enable `hub.kv` and cache the definitions catalogue.** The intended plan
  until the build showed no binding is emitted. It would also have made a
  just-created definition eventually consistent in the grant picker, which is
  worse UX than the query it replaces.
- **`defineCachedFunction` around `loadRoles`.** Rejected on the rule above. It
  is the single highest-traffic read and the one where staleness is a privilege.
- **A request-context memo for `loadRoles`.** Sound, but it turned out to be
  solving a problem that passing the value already solved, and it would have been
  wrong in `roles.put.ts`, which reads grants either side of a write.
- **Public `Cache-Control` on admin reads.** They contain personal data.

## Consequences

Good: every admin request does two fewer queries and the users list does two
fewer again, with no cache to invalidate and no consistency question anywhere;
the manifest poll is nearly free; and there is a written answer for the next
person who asks why this service does not cache more.

Bad: read volume still scales linearly with traffic, so if this service ever
serves a genuinely larger estate this decision needs revisiting, and revisiting
it means the infrastructure work above rather than flipping a flag.
