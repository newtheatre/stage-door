# ADR-0018: Apps declare their own roles; this service polls for them

**Status:** Accepted · **Date:** 2026-08-18 · **Deciders:** IT Manager · Partially supersedes [ADR-0011](0011-role-definitions-and-expiry.md) (definitions as hand-entered UX metadata) · Builds on [ADR-0017](0017-app-registry.md)

## Context

[ADR-0011](0011-role-definitions-and-expiry.md) introduced `role_definitions` to
make granting a dropdown rather than a typed string, and
[ADR-0014](0014-grants-require-definitions.md) made a definition mandatory for a
new grant. Both left the definitions themselves hand-entered here.

That leaves the same fact written twice, in two repositories, by two people. An
app that ships a new role needs an admin to notice and type it in, with nothing
checking the spelling matches what the app reads. Worse in the other direction:
when an app stops reading a role, nothing tells anyone, so the definition sits in
the picker looking grantable forever. ADR-0014 removed free-text granting because
"a typo'd `prosenium:BOX_OFFICE` is a grant that silently does nothing,
indistinguishable in the admin UI from one that works". A hand-copied definition
has exactly that failure mode, one level up.

The app is the only party that knows which roles it actually checks. It is also
the only party that changes them, and it changes them in a commit.

## Decision

Each app serves its role vocabulary at `GET /api/_hooks/auth/manifest`, and this
service polls it and reconciles the result into `role_definitions`. **Adding a
role is a deploy of the app that owns it, and nothing else.**

The manifest is authored as one typed const in the app's own `shared/utils/appManifest.ts`,
which is also what the app's own checks read. A published manifest therefore
cannot drift from what the app enforces, because they are the same object.

It sits under `_hooks/` and takes the same bearer as the GDPR hooks, the SHA-256
of the app's own service token. Both sides already had that machinery, so
authenticating cost nothing; a manifest enumerates every capability an app knows
about, and there is no reason to publish that to anyone who asks.

**Roles carry permissions.** An app declares a permission vocabulary and which
role bundles which permissions. The session is unchanged and still carries role
strings only; each app resolves permissions locally from its own manifest, which
is its own source code. This service stores the map for the admin UI and for
answering "who can approve refunds?", and never puts it in a cookie. Permission
keys are lowercase and dotted (`money.refund`) where roles are uppercase
(`BOX_OFFICE`), so no string can be read as both.

**Nothing is ever withdrawn except as a consequence of a document that parsed.**
A timeout, a 5xx, malformed JSON, a schema failure, an oversized body and a
namespace mismatch all take one path: stamp the error, leave the stored document
and every definition untouched, and show the app red in the admin UI. A five
minute outage must never be able to withdraw an app's entire role set.

Reconciliation, in order:

1. **Namespace gate.** The manifest's namespace must equal the registry row's, or
   the whole document is refused. Otherwise a misconfigured or compromised app
   could claim another's namespace and mint itself definitions. `auth` is refused
   from any manifest: `auth:ADMIN` stays hand-made forever, so a broken sync can
   never remove the ability to fix a broken sync.
2. **Hash short-circuit.** An unchanged document, by SHA-256 or a 304 against the
   stored ETag, updates timestamps and stops. Daily polling is therefore close to
   free, and reconciliation is idempotent by construction.
3. **Permissions**, upserted on `(namespace, key)`. Undeclared ones are
   deactivated, never deleted: role links and audit detail point at the row.
4. **Roles.** New ones are inserted. A pre-existing **manual** definition of the
   same `(namespace, role)` is **adopted**, with its previous values written to
   the audit log so the change is reversible by hand. `(namespace, role)` is
   unique, so the alternatives were a hard failure or two sources of truth for
   one row; the manual row was a stand-in for exactly the thing that has arrived.
5. **Withdrawal.** A manifest-sourced role this app no longer declares gets
   `withdrawn_at`. **Grants are never touched and the row is never deleted**
   ([ADR-0011](0011-role-definitions-and-expiry.md)'s guarantee). It leaves the
   grant picker and shows struck through with its holder count, which is the
   prompt to revoke deliberately. Re-declaring it clears the flag.

**Default expiry and eligibility mode are pinnable.** A manifest seeds them; an
admin edit pins the field, after which the manifest cannot move it. The app knows
which training question is relevant to a role, but the committee decides whether
an unmet answer removes access, and the committee-year policy is this service's.
An app must not be able to lock people out of itself with a deploy.

**Pull, with an optional ping.** A role vocabulary changes a handful of times a
year, so frequent polling is almost entirely wasted requests. The ping
(`POST /api/apps/sync`, authenticated by the app's own service token, so it can
only ever ask for itself, rate-limited so a deploy loop cannot hammer it) is what
delivers a change, seconds after the deploy that made it. The admin Sync now
button covers bootstrapping. A daily backstop on the existing 04:00 cron catches
an app whose ping quietly stopped; it registers no new cron trigger.

`manifest_enabled` is off by default, so the first sync of each app is done by an
admin watching the result rather than by a cron. Adoption rewrites a manual
definition's description and default expiry, and a silent change to a
committee-set expiry is an argument waiting to happen.

## Alternatives considered

- **Keep hand-entering definitions.** The status quo, and the thing that makes a
  role's spelling a matter of trust between two repositories.
- **Push only: apps POST their manifest.** Faster, but it makes an unreachable app
  indistinguishable from an app with nothing to say, and it puts the write path
  behind whatever the app decides to send and when. Pull means this service
  chooses when to ask and always knows whether the answer arrived.
- **A shared `packages/app-manifest` copied into each app**, as `nntAuth.ts` is.
  Rejected: it doubles the "never edit a copy" surface for no runtime benefit.
  Consumers author a plain typed const; this service validates on ingest.
- **A public manifest endpoint.** Simpler and edge-cacheable, but with ETags and
  the hash short-circuit the caching is worth nothing at daily polling, and the
  auth already existed on both sides.
- **Delete withdrawn definitions.** Cleaner-looking and it destroys the
  information that someone still holds the role.
- **Let the manifest set the eligibility mode outright.** Rejected: see pinning.

## Consequences

Good: a role exists in one place, the app that reads it; a definition provably
matches something an app checks; withdrawal is visible rather than silent;
"who can approve refunds?" is one SQL join; the namespace table in
`integrating-an-app.md` is already gone, and now the definitions follow.

Bad: this service now makes outbound requests on a schedule and can be wrong
about an app for a day if a ping fails and nobody looks, so the admin screen has
to surface sync age and failure loudly, and does. Adoption is a one-way door per
role: an adopted definition's description and expiry come from the manifest from
then on, and the way back is the audit entry plus a pin. The manifest contract is
versioned (`contract: 1`) because changing its shape is the one thing here that
does still require a deploy of this service.
