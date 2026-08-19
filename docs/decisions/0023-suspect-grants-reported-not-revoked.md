# ADR-0023: Suspect grants are reported, never revoked

**Status:** Accepted · **Date:** 2026-08-20 · **Deciders:** Matt Adcock (ITM 26/27) · Builds on [ADR-0014](0014-grants-require-definitions.md) and [ADR-0018](0018-manifest-declared-roles.md)

## Context

A grant is a scoped string on a row. Nothing about `proscenium:BOX_OFICE` looks different from `proscenium:BOX_OFFICE` in the admin UI: both render as a chip, both survive a session refresh, and both do exactly nothing in the app that was supposed to read them. ADR-0014 closed the front door by requiring new grants to reference a definition, but three ways in remain:

- The legacy import created `ticketing:*` grants for an app that does not exist yet (ADR-0010), so a whole namespace is deliberately dormant.
- An app can withdraw a role from its manifest (ADR-0018) while people still hold it.
- A namespace can stop being registered, or never have been, leaving grants nothing reads.

The service already had the machinery to find these (`findSuspectGrants`) and a daily task to report them, but the decision behind it was never written down. Six code sites and a documentation heading cited **ADR-0021** for it, which is about applying migrations from CI and says nothing about grants. A successor reading `rolesConfig.ts` to learn why `ticketing` is dormant landed on a document about `_hub_migrations`.

## Decision

**Suspect grants are surfaced, never acted on automatically.** `findSuspectGrants` classifies a grant as one of three problems, and the `roles:expiry-warn` task emails the digest to the IT Manager alongside the expiry warnings, because it is the same daily read of the role table.

| Problem | Meaning |
| --- | --- |
| `unknown-namespace` | No registered app owns the namespace, so nothing reads it |
| `undefined-role` | The app exists but declares no such role |
| `withdrawn` | The app stopped declaring the role; holders keep it until revoked |

Nothing is revoked, and no grant is filtered out of a session on this basis. `ROLES_CONFIG.dormantNamespaces` suppresses the report for namespaces that are known to be waiting for an app rather than broken, so the digest stays worth reading.

## Alternatives considered

- **Revoke automatically.** Rejected: an app deploying a manifest with a typo, or a registry row briefly missing, would strip real people of real access with no human in the loop. The same reasoning already keeps an `:ADMIN` role out of enforcing training prerequisites (ADR-0019).
- **Refuse the grant at write time and stop there.** ADR-0014 does this, and it is necessary but not sufficient: it cannot see a role withdrawn *after* the grant, which is the common case at handover.
- **Its own scheduled task.** Rejected: it is the same query over the same table on the same schedule as the expiry warnings, and a second cron is a second thing to notice has stopped.
- **Surface only in the admin UI.** Rejected: the failure is invisible by construction, so it has to arrive somewhere the ITM already looks.

## Consequences

Good: a typo grant becomes visible within a day instead of at the point someone complains a permission does not work. Dormant namespaces stay quiet, so the report means something. Nothing this service does can take access away without a person deciding to.

Bad: acting on the report is manual, and a digest nobody reads is no better than no digest. The suppression list is a place a real problem can hide if a namespace is left on it after its app ships, so it belongs in the handover checklist.
