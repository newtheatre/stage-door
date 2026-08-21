# ADR-0025: Publish auth-types as a package

**Status:** Accepted · **Date:** 2026-08-21 · **Deciders:** Matt Adcock (ITM 26/27)

## Context

`packages/auth-types/index.ts` is the estate's session contract: the `#auth-utils` module
augmentation and the `hasRole`/`hasAnyRole`/`permissionResolver`/`isStale` helpers every app
compiles against. It has always been copied verbatim into `shared/utils/nntAuth.ts` in proscenium,
rooms and rehearsal, headed "DO NOT EDIT HERE" and kept in sync by hand.

The cost stopped being hypothetical: rooms' one remaining `typecheck` error is this exact file
failing to resolve its own augmentation, because nothing else in rooms' `shared/` project happens
to import `#imports`. proscenium and rehearsal currently pass, but only because something unrelated
elsewhere in each of their `shared/` directories incidentally does. Three copies of the same file,
resolving correctly or not depending on what else happens to sit next to them, is not a contract.

The choice was between a git-referenced dependency and a registry. "As locally as possible" ruled
out public npm; it did not by itself answer git-vs-registry.

## Decision

**Publish `@newtheatre/auth-types` to GitHub Packages.** The name was already correctly scoped to
the `newtheatre` org.

Three consequences of publishing it as a real package rather than a workspace-only reference:

- **It needs a build.** `main`/`types` pointed straight at `index.ts`, which only worked because
  stage-door consumes it through a Bun workspace, whose runtime transpiles TypeScript directly.
  Three separate apps, each with its own Vite/Nitro build, is a different consumption path, and raw
  `.ts` in `node_modules` is not reliably transformed by default. `unbuild` (zero-config for a
  single-entry package) now emits `dist/index.mjs` + `dist/index.d.mts`.
- **It needs a publish trigger.** `.github/workflows/publish-auth-types.yml` runs on push to `main`
  when `packages/auth-types/**` changes, builds, and publishes whatever version is currently in
  `package.json`, skipping if that version already exists. A version bump is a hand-edit in the PR,
  same as any npm package. Auth is the workflow's own `GITHUB_TOKEN` with `packages: write`; no new
  secret.
- **Consumption needs to be deliberate, not incidental.** Each consumer app adds
  `shared/types/auth.d.ts`, a one-line side-effect `import '@newtheatre/auth-types'`, exactly
  matching the file this app already carries for its own workspace reference. That import is what
  pulls the `#auth-utils` augmentation into each app's TypeScript project on purpose. Rooms' error
  is this import missing, not a rooms-specific problem: proscenium and rehearsal get the same file
  now, so they stop passing by accident too.

stage-door keeps consuming its own package via `workspace:*`. It is the source; there is no reason
for its own build to round-trip through the registry to use its own code.

## Alternatives considered

- **A git-referenced dependency**, each consumer's `package.json` pointing at a path or tag in
  stage-door's repo. Lost on two counts: it still ships raw TypeScript, so the build-step problem
  above is unchanged, and pinning a commit or tag is a worse version story than a real registry
  gives for free, with no visible "what version is everyone actually on" answer.
- **Keep copying, but police the copy** with a CI check that fails when a consumer's file drifts
  from stage-door's. Lost because it treats the symptom, not the duplication, and does nothing for
  rooms' actual error: that needs the same `shared/types/auth.d.ts` fix regardless of where the
  source file lives.
- **Public npm.** Ruled out directly: this is estate-internal, and "as locally as possible" was the
  instruction that started this.

## Consequences

Good: one file, one place to change it, three short PRs to bump a version instead of three manual
copies to keep byte-identical by hand. Rooms' typecheck error is fixed as a side effect, not a
separate task. A future change to the session contract now has a version number, so "which shape of
the contract is this app actually running" is answerable instead of assumed.

Bad: a new failure mode. If the registry or the publish workflow is unavailable, a consumer app
cannot get a fresh install of its own dependency, where before the file was always just there.
Versioning now needs actual discipline: a breaking change to the contract is a major bump, not a
silent edit picked up on the next copy. Local development needs a personal GitHub Packages read
token, a one-time setup step that did not exist before for anyone cloning a consumer app fresh.
