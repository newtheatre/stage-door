# ADR-0014: New grants must reference a role definition

**Status:** Accepted · **Date:** 2026-08-14 · **Deciders:** Matt Adcock (ITM 26/27) · Partially supersedes [ADR-0004](0004-scoped-role-strings.md) and [ADR-0011](0011-role-definitions-and-expiry.md) (the "no mandatory registry" stance)

## Context

ADR-0004 and ADR-0011 both deliberately kept role granting open: free-text grants worked without a definition, "so a namespace can still exist before its definitions do". In practice that openness bought nothing and cost UX. Every real role already had a definition; the free-text path's only live use was creating strings nothing checks: a typo'd `prosenium:BOX_OFFICE` is a grant that silently does nothing, indistinguishable in the admin UI from one that works. And the grant editor had to carry an "Advanced" escape hatch whose main effect was making the common path feel provisional.

## Decision

**A role that isn't defined can't be granted.** `PUT /api/users/:id/roles` refuses any role string the user does not already hold that has no matching row in `role_definitions` (400, naming the role). The free-text UI is gone; the grant picker links to the definitions page for anything missing. Creating a definition remains a two-field form, so "define first, then grant" costs one extra click on a path taken a few times a term.

**Grants the user already holds are exempt**, whatever their string. This is what keeps history manageable:

- The dormant `ticketing:*` namespace (ADR-0010) has no definitions by design: those grants stay renewable, annotatable, and removable.
- Deleting a definition still never touches grants (unchanged from ADR-0011); the holders keep the role and it remains editable. The definition's absence only prevents *new* grants.

What survives from ADR-0004/0011: scoped strings everywhere (session shape, app checks: consumer apps unaffected); definitions stay UX metadata that apps never read; expiry and provenance semantics unchanged.

## Alternatives considered

- **Keep free-text behind Advanced**: rejected: it existed to serve a flexibility no one used, and its failure mode (typo grants that check nothing) is invisible.
- **FK from `user_roles` to `role_definitions`**: rejected: schema churn, and it would make deleting a definition either cascade into grants (destroying ADR-0011's guarantee) or be blocked by them. Validation at the write path gets the same effect for new grants without touching history.
- **Auto-create a definition on free-text grant**: rejected: it launders typos into the registry.

## Consequences

Good: a granted role now provably matches something an app checks (or is pre-existing history, visibly so); the grant editor has one path instead of two; the definitions page is the single source of what roles exist.

Bad: bootstrapping a new app's roles requires visiting the definitions page first: accepted, that's the point. If a bulk import of grants is ever needed again (another legacy migration), it goes through direct DB scripts like the first one did, not the API.
