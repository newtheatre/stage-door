# ADR-0002: Standalone service at auth.newtheatre.org.uk

**Status:** Accepted · **Date:** 2026-08-09 · **Deciders:** Matt Adcock (ITM 26/27)

## Context

Identity had two possible homes: inside Proscenium (which already owned the richest user table) or as its own worker. A third option was no service at all: a shared library with a shared database.

## Decision

A standalone Nuxt app in its own repo (`newtheatre/stage-door`, worker `stage-door`), own worker, own D1 database, at `auth.newtheatre.org.uk`. It is the single identity store and the single session writer.

## Alternatives considered

- **Proscenium as IdP**: least new infrastructure; lost because it welds the public website's lifecycle (redesigns, content work, box-office rushes) to the identity system every other app depends on, and makes "who owns identity?" permanently ambiguous.
- **Shared library + shared auth DB, no service**: cheapest to run; lost because every app would ship its own copy of auth code against a shared schema: version drift across apps becomes a security problem, and there is no single place for the admin UI, hosted login, or audit log.

## Consequences

Good: clear ownership, independent deploys, the login UI exists once, apps stay small. Bad: one more worker and repo to operate (mitigated: the ops runbook, and Cloudflare free tier means no cost); guest checkout in Proscenium now has a runtime dependency on the auth service (accepted: same account, same platform, fail-with-retry).
