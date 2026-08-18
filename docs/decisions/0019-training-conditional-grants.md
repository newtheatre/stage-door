# ADR-0019: Training-conditional grants, from a cached snapshot

**Status:** Accepted · **Date:** 2026-08-18 · **Deciders:** IT Manager · Builds on [ADR-0018](0018-manifest-declared-roles.md)

## Context

Some privileges should depend on current training. Duty managing is the obvious
one: the committee's position is that the person holding the keys has done the
course, and that if their certification lapses they stop duty managing. Today
those are two unconnected facts. `rehearsal` knows whether someone is qualified;
this service hands out the privilege; nothing joins them, so a lapse is caught
only if a human notices.

`rehearsal` already answers the question properly. Its `eligibility_rules` are
named, data-driven and deliberately app-agnostic
(its ADR-0006: "this app answers; consumers enforce"), and
`GET /api/v1/eligibility/:key` returns the eligible set or one person's answer
with what they are missing. Nothing in the estate consumed it.

The obvious implementation, calling `rehearsal` when sealing a session, is the
wrong one. It puts a second service on the login path, and it means a training
outage logs the estate out of its privileges.

## Decision

A role definition may name one of `rehearsal`'s eligibility rule keys and choose
**advisory** or **enforcing**. An admin still grants the role deliberately; an
enforcing prerequisite makes the grant **inert** when the holder is not
qualified. The grant row is untouched, so it recovers by itself when they
re-qualify.

**The snapshot is the authority; there is never a live call.** A daily task
reads each referenced rule from `rehearsal` and replaces
`eligibility_snapshots`, which holds only the eligible set (presence means
eligible, so the SQL predicate is a bare `not exists`). `loadRoles` filters on
that table and nothing else.

**Only `loadRoles` filters.** `activeRoleCondition` keeps its exact previous
meaning, and holder counts, the admin `?role=` filter and the retention sweep's
exemption are unchanged. Someone granted a role but blocked on training is still
a holder, and the admin UI says so rather than pretending the grant is absent.
The narrower `effectiveRoleCondition` is the seal path only.

**The predicate binds three parameters, whatever the data.** The user id, the
active-grant cutoff, and the override cutoff. Everything else is a column or a
literal. It is on the seal path for every login in the estate, and D1 caps a
statement at 100, so a test asserts the count rather than trusting it.

### The failure direction, chosen deliberately

| Situation | Behaviour |
|---|---|
| Snapshot fresh, holder in it | Live. |
| Snapshot fresh, holder absent | **Inert**: absent from the session everywhere. |
| `rehearsal` down, snapshot exists | **Last known good, indefinitely.** Nobody's access changes because of an outage. The error surfaces in the admin UI. |
| Rule never successfully answered | **Enforcement does not engage.** A configuration mistake must not lock the estate out. |
| Snapshot wrong, or training earned during an outage | Admin sets `user_roles.eligibility_override_until`, audited, capped at 90 days, lapses on its own. |
| Mode is advisory | Never filters. Warning in the admin UI only. |

Enforcement is **never automatically lifted by staleness**. Lifting on staleness
would make an outage grant privileges, which is worse in every direction than
leaving the last real answer in force.

**An enforcing prerequisite is refused on any `ADMIN` role**, in the API and in
manifest reconciliation. Without that, a wrong snapshot could remove every
`training:ADMIN`, which removes the ability to correct the rule in `rehearsal`,
which is unrecoverable without direct database access. This is the real hazard
in coupling the two services, and this is its fix.

This stretches `rehearsal`'s own guidance that eligibility is "advisory-fresh,
never transactional": a snapshot up to a day old can remove a role. It is
defensible because this service never blocks on the API, never fails a request
because of it, and degrades to the last real answer rather than to a decision.
It is recorded in `rehearsal`'s own decision records rather than left for
someone to discover.

## Alternatives considered

- **Call `rehearsal` when sealing.** Puts a second service on every login and
  makes a training outage an estate-wide authorisation outage.
- **Auto-grant from training** (holding the certification *is* the role).
  Rejected: a training data-entry slip becomes a live privilege grant with no
  admin in the loop, and there is then no record of anyone deciding.
- **Advisory only.** Safe, and it leaves the lapse problem exactly where it was,
  on a human checklist that history says gets missed.
- **Fold eligibility into `activeRoleCondition`.** One predicate is tidier and it
  silently changes holder counts, the role filter and the retention exemption,
  none of which mean "currently effective".
- **Store the full answer** (`{eligible, missing, expiring}`) per person.
  Rejected: this service has no use for *why*, and the eligible-set form is one
  request and one small table.

## Consequences

Good: a lapsed certification removes the privilege within a day with no admin
action, which is exactly the property `rehearsal` already has internally for
trainer standing; the override gives a way out when the data is wrong; the
existing estate is unaffected until someone sets a key, because every definition
ships with `requires_eligibility_key` null and `effectiveRoleCondition` is then
exactly `activeRoleCondition`.

Bad: this service now depends on `rehearsal` being reachable *eventually*, and a
silent snapshot failure means enforcement runs on stale data for as long as
nobody looks, so sync age has to be visible and is. `loadRoleGrants` costs one
extra query to report inert grants. And the coupling is real: the two services
now have to be released with each other in mind when the eligibility API shape
changes.
