# ADR-0017: The estate's apps live in a database registry, not in code

**Status:** Accepted · **Date:** 2026-08-18 · **Deciders:** IT Manager · Partially supersedes [ADR-0004](0004-scoped-role-strings.md) (the "no app registry" stance)

## Context

[ADR-0004](0004-scoped-role-strings.md) decided against an app registry, on the
reasoning that "a namespace exists when its first role is granted" and that a
registry was ceremony for an estate of three apps. That held while the only
thing the service needed to know about an app was the namespace string on a
grant.

It stopped holding once the service had to *call* apps. `HOOK_APPS` in
`server/utils/appHooks.ts` was a hardcoded array of two entries, and it was the
sole answer to "which apps exist" on the outbound path. Three costs followed.

Adding an app to the estate meant editing and redeploying the auth service.
`docs/integrating-an-app.md` step 8 said "register your base URL with the ITM",
which meant a source change in a repo the integrating developer usually has no
reason to touch.

The same fact was recorded in three unconnected places: `service_tokens.name`
rows, the `HOOK_APPS` const, and a hand-maintained namespace table in
`integrating-an-app.md`. That table already listed a `photos` namespace with no
grants, no token and no app.

And it was silently wrong. `rehearsal` shipped all four GDPR hooks
(`server/api/_hooks/auth/`) and was never added to `HOOK_APPS`, so erasure,
export, merge and last-activity had never once reached the training records.
`callAllAppHooks` iterates the array, so a missing app produces no error and no
absent result. Nothing could have caught it except someone noticing.

## Decision

An `apps` table is the registry. A row carries the app's name, its role
namespace, a display name, its base URL and whether it receives hooks.
`callAllAppHooks` fans out over rows with `hooks_enabled`, and `callAppHook`
resolves the base URL per call rather than from a const. `HOOK_APPS` is gone.

**`name` and `namespace` are separate columns.** `rehearsal` serves the
`training` namespace, and collapsing the two would encode a coincidence that is
already untrue for one of four apps.

**Registering an app is an admin action at `/admin/apps`, and needs no deploy of
this service.** That is the point of the change. A migration seeds the three
apps that exist, `rehearsal` among them with hooks enabled, which closes the gap
above.

`service_tokens` gains a nullable `app_id` so the relationship is queryable, but
the existing join on `service_tokens.name = apps.name` stays as the authority
for `hookBearer`. A missed backfill therefore cannot break hooks. The column has
no `ON DELETE` clause: SQLite cannot add one to an existing table, and rebuilding
the table holding every app's credentials to gain a cascade is not a trade worth
making. `DELETE /api/apps/:id` clears the link before deleting the row.

`hooks_enabled` defaults to off. A half-registered app that silently swallowed
an erasure would reproduce the defect this ADR exists to fix, in a form that
looks like success.

## Alternatives considered

- **Keep `HOOK_APPS`, add `rehearsal` to it.** Fixes the live defect and nothing
  else. The next app repeats the whole story, and the three-places problem is
  untouched.
- **Derive the app list from `service_tokens`.** Tempting, since a row already
  exists per app, but a token is a credential and an app is a thing with a
  URL and a lifecycle. Rotating a token would have meant deregistering an app.
- **A config file rather than a table.** Still a deploy, and it cannot hold the
  sync state that [ADR-0018](0018-manifest-declared-roles.md) needs.
- **Let apps self-register on first hook call.** An unauthenticated write of a
  base URL that the service will later send bearer tokens to. Rejected on sight.

## Consequences

Good: adding an app is a form, not a release; the base URL can be corrected
without a deploy, which also makes the estate testable end to end on ports
3000-3003 with `http://localhost` origins; `rehearsal` receives hooks; the
registry is the one place that answers "which apps exist", so the namespace
table in `integrating-an-app.md` can be deleted rather than maintained.

Bad: `HookApp` was a literal union derived from the const, and is now `string`,
so `callAppHook('prosenium', …)` no longer fails to compile. The registry
returns a failed `HookResult` for an unknown name and a test covers it, but the
compile-time check is genuinely lost, and that is the price of a runtime
registry. A registered app with no service token cannot be called at all; the
admin list flags it, because the failure is otherwise only visible in a hook
error log.
