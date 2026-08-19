# ADR-0024: Role definitions come only from manifests

**Status:** Accepted · **Date:** 2026-08-20 · **Deciders:** Matt Adcock (ITM 26/27) · Supersedes the by-hand definition editing in [ADR-0011](0011-role-definitions-and-expiry.md) · Extends [ADR-0018](0018-manifest-declared-roles.md) to this service's own roles

## Context

ADR-0018 made an app's manifest the source of its role vocabulary: "Adding a role is a deploy of the app that owns it, and nothing else." But the admin API kept the by-hand endpoints ADR-0011 introduced, so `role_definitions` had two writers. To stop them fighting, two pin columns were added: an admin edit set `default_expiry_pinned` or `eligibility_mode_pinned`, after which a manifest could not move that field.

The pinning was incomplete, which is how it came to attention (#70). `eligibility_mode_pinned` preserved the *mode* but not `requires_eligibility_key`, so an app could still change which training rule a pinned role depended on. Once a snapshot existed for the new key with no rows for the current holders, every one of them lost the role from their sealed session: an app-supplied document silently revoking access estate-wide, on a role an admin had explicitly pinned.

Pinning the key too would have closed that instance. It would not have addressed the shape: two writers, a per-field flag deciding which one wins, and a reader who cannot tell from the row why a value is what it is. Every field added to a definition raises the same question again.

## Decision

**A role definition can only come from a manifest.** `POST`, `PUT` and `DELETE /api/role-definitions` are removed, both pin columns are dropped, and the admin page is read-only. `GET` is unchanged.

**This service declares its own roles the same way.** `auth:ADMIN` was previously a hand-made row, which is why the by-hand endpoints could not simply be deleted. stage-door now has `shared/utils/appManifest.ts` and serves it at `/api/_hooks/auth/manifest` on the same contract as every consumer app, and is registered in `apps` with `namespace: 'auth'`.

One asymmetry, deliberate: the sync reads that manifest **in-process** rather than fetching it. A Worker making a subrequest to itself to read a constant in its own bundle would be slower, would need a service token issued to itself, and would fail in a way no consumer app can. `fetchManifest` short-circuits when the app's namespace is its own.

`ticketing:*` stays as frozen `source: 'manual'` history (ADR-0010). Nothing can create another: the rows exist, and no code path writes one.

## Alternatives considered

- **Pin the eligibility key alongside the mode.** The minimal fix for #70. Lost because it leaves two writers and a growing set of per-field flags, and the next field added is the next instance of the same bug.
- **Keep the endpoints, drop the pins, let the manifest always win.** Simpler, and closes #70. Lost because an admin edit would then be silently reverted at the next sync, which is worse than not offering it: the UI would be lying about what it does.
- **Keep by-hand definitions for `auth:*` only.** Avoids the self-manifest machinery. Lost because "manifest-only, except here" is the kind of exception that grows, and this service's roles are exactly the ones worth holding to the rule.

## Consequences

Good: one writer, so no pins, no precedence rules, and no field-by-field question about who wins. A definition's provenance is always the same answer. This service's own roles are under the same discipline as everyone else's, and its permission vocabulary is now declared rather than implied.

Bad: defining a role now requires a deploy of the owning app, which is slower than editing a form, and there is no in-app escape hatch. That is the intended trade, but it means a typo in a manifest is fixed by another deploy. The suspect-grants report (ADR-0023) is what surfaces a grant left pointing at a role that never arrived.

Also bad: an operator can no longer correct a bad default expiry centrally, so an app shipping `{ kind: 'days', days: 1 }` by mistake affects new grants until it deploys again. Existing grants keep the expiry they were given, so the blast radius is bounded to whatever is granted in between.
