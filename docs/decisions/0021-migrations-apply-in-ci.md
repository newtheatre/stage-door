# ADR-0021: Migrations apply from CI, and the service reports when they have not

**Status:** Accepted · **Date:** 2026-08-19 · **Deciders:** IT Manager

## Context

On 2026-08-19 every login on the estate returned 500 for roughly an hour.

Six pull requests had merged that morning, each deploying cleanly. The
database was still at migration `0004`. The deployed code queried
`eligibility_syncs` and `eligibility_snapshots` inside `loadRoles`, which runs
on every session seal, so every login and every admin page failed. The
`_hub_migrations` table showed the last successful application was six days
earlier.

Nothing in the deploy path had ever applied a migration. Deploys run through
Cloudflare's Workers Builds git integration, which builds and deploys and does
nothing else. NuxtHub's own migration runner assumes NuxtHub-managed
deployment, which this repo does not use: the same reason `hub.kv` emits no
binding here ([ADR-0020](0020-what-this-service-caches.md)). Migrations
`0000`–`0004` had been applied by hand during the cutover, at times that look
like someone running `wrangler` locally, and nobody noticed that the
automation everyone believed in did not exist.

`docs/operations.md` said "merging `main` builds and deploys automatically",
and the estate `CLAUDE.md` said "merging to `main` applies migrations to
production". The first was true. The second never was.

Three failures compounded:

1. **Nothing applied migrations.** Not a regression; it had never worked.
2. **Nothing noticed.** A green build and a green deploy meant a deploy that
   could not serve a request. `GET /api/health` returned `ok: true` throughout.
3. **The documentation asserted the mechanism existed**, so nobody looked.

## Decision

**A GitHub Actions job applies pending migrations on push to `main`.**
`.github/workflows/migrate.yml` runs `scripts/migrate-remote.mjs` with the
`CLOUDFLARE_API_TOKEN` secret that already exists for backups.

The script keeps NuxtHub's bookkeeping: it diffs `server/db/migrations/sqlite/*.sql`
against the `_hub_migrations` table, applies what is missing in filename order,
and records each only after it succeeds, so a failure leaves the rest pending
rather than half-recorded. It is idempotent, has a `--dry-run`, and the workflow
runs the dry-run before and after applying so the log shows what changed.

Actions starts within seconds and applies in seconds; a Workers build takes
minutes. Additive migrations therefore land before the code that needs them.
That ordering is a property of the timing, not a guarantee, which is the second
half of this decision:

**`GET /api/health` fails when the schema is behind the code.** It compares the
migration journal compiled into the build against `_hub_migrations` and returns
503 with the pending filenames. A deploy that cannot serve requests now says so
in the place uptime monitoring already looks, and says exactly what is wrong.

Migrations stay expand-only in practice: additive changes tolerate either
ordering, and anything destructive is still applied by hand before merging, as
the estate `CLAUDE.md` requires.

## Alternatives considered

- **Apply migrations from the worker on boot or first request.** Tempting,
  because it cannot race the deploy. Rejected: isolates start concurrently, so
  several would race the same migration, and a failure would surface as a
  request error rather than a deploy error.
- **Move deployment into GitHub Actions** so migrate-then-deploy is one ordered
  job. Genuinely correct, and a larger change than an outage response should
  make: it changes how all four repos deploy. Worth revisiting deliberately.
- **`wrangler d1 migrations apply`.** Wrangler keeps its own `d1_migrations`
  table and does not understand NuxtHub's `--> statement-breakpoint` format, so
  adopting it would mean two ledgers disagreeing about the same database.
- **Document a manual step instead.** This incident is what a manual step looks
  like when the documentation claims otherwise.

## Consequences

Good: merging now really does apply migrations; a schema gap is loud and named
rather than silent; the runner works for any environment, so a future staging
database needs no new tooling.

Bad: the token gains a genuinely privileged use, so its scope matters more than
it did when it only wrote backups. And the ordering between migration and
deploy is timing, not sequencing — an unusually slow Actions queue with an
unusually fast build could still land code first. The health check is the
backstop, and moving deployment into CI is the real fix if this ever bites.
