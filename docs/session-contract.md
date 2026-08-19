# Session Contract

**Version 1.0 — bump this header and note changes below whenever the shape changes.** This is the interface every consumer app compiles against. Additive changes only; removing or renaming a field requires an ADR and a coordinated release of every app.

## The cookie

| Property | Value |
|---|---|
| Name | `nnt-session` |
| Domain | `.newtheatre.org.uk` |
| Flags | `Secure; HttpOnly; SameSite=Lax; Path=/` |
| Max age | 30 days |
| Format | `nuxt-auth-utils` sealed session (iron-webcrypto), secret `NUXT_SESSION_PASSWORD` |
| Writer | The auth service **only** |

Every app sets identical values in `nuxt.config.ts`:

```ts
runtimeConfig: {
  session: {
    name: 'nnt-session',
    password: '', // filled at runtime from the Secrets Store — see integrating-an-app.md §1b
    maxAge: 60 * 60 * 24 * 30,
    cookie: { domain: '.newtheatre.org.uk', sameSite: 'lax', secure: true },
  },
},
```

Local development uses a different config (no domain) — see [development.md](development.md).

## The payload

Defined once in `packages/auth-types` (types + helpers). It is **not** published to a registry —
each consumer app carries a verbatim copy at `shared/utils/nntAuth.ts`, headed "DO NOT EDIT HERE".
Change the source, then re-copy to Proscenium, rooms and rehearsal in the same PR. Do not redeclare
the shape inline anywhere.

```ts
declare module '#auth-utils' {
  interface User {
    id: string            // canonical user id — stable forever, apps FK against it
    email: string         // lowercased
    name: string
    verified: boolean     // email verified; always true for Google sign-ins
    guest: boolean        // true = shadow account (no password ever set)
    roles: string[]       // scoped: 'proscenium:ADMIN', 'rooms:ADMIN', 'auth:ADMIN', …
  }
  interface UserSession {
    loggedInAt: number    // epoch ms of the original login
    refreshedAt: number   // epoch ms of the last DB re-read — drives staleness checks
    epoch: number         // copy of users.session_epoch at seal time — drives force-logout
  }
}
```

Helpers (same package): `hasRole(user, app, role)`, `hasAnyRole(user, app, ...roles)`, `isStale(session, maxAgeMs)`, `permissionResolver(manifest)`.

**Permissions are deliberately not in the payload.** An app declares its permission vocabulary in its
own manifest ([ADR-0018](decisions/0018-manifest-declared-roles.md)) and resolves it locally with
`permissionResolver`, which is a pure function of the role strings already here. Sealing the resolved
set instead would grow with (apps × roles) against a 4 KB cookie, and would move into this contract
the one thing each app understands best about itself ([ADR-0004](decisions/0004-scoped-role-strings.md)).
Do not add it.

## Rules for consumer apps

1. **Read-only.** Use `getUserSession(event)` / `requireUserSession(event)` / `useUserSession()`. Never call `setUserSession`, `replaceUserSession`, or `clearUserSession` — logout is a POST to the auth service. (Documented temporary exception during Proscenium's integration: none in steady state.)
2. **Privileged routes check staleness.** Before honouring any role in `roles`, middleware guarding admin/staff surfaces must ensure `Date.now() - session.refreshedAt < 15 * 60_000`; otherwise redirect the browser to `https://auth.newtheatre.org.uk/api/session/refresh?redirect=<current-url>` (or fetch it server-to-server). Refresh re-reads the user, rejects disabled accounts and stale `epoch`s, re-seals, and bounces back. Ordinary logged-in browsing must **not** refresh — that would put the auth service on every request path.
3. **Ignore unknown fields.** Future versions may add fields; never fail on extras.
4. **Roles you don't own are none of your business.** An app reads only its own namespace (plus nothing else). Granting/revoking happens in the auth service admin UI only.
5. **Mirror upsert.** Apps with user FKs upsert `{id, email, name}` into their local mirror table from the session in their auth middleware (`ensureLocalUser`).

## Semantics worth knowing

- **`guest: true`** users exist so reservations always have an owner. They cannot log in (no password, no Google link). They become full users in place when a password is set or Google is linked — same `id`, `guest` flips to false at next seal.
- **`verified`** gates nothing estate-wide by policy; apps decide locally what unverified users may do (Proscenium: book tickets yes; rooms carried forward its no-verification-required behaviour).
- **Role changes propagate within 15 minutes** on privileged surfaces, at next natural refresh otherwise, and instantly if the admin also bumps the user's epoch (force-logout button).
- **Clock skew** is a non-issue (all parties are Cloudflare Workers), but treat `refreshedAt` comparisons defensively; negative ages count as stale.

## Change log

- **1.0** — initial contract (Phases 1–2 of the implementation plan).
- **1.0** (unchanged payload, 2026-08-18) — `permissionResolver` added to the helpers for
  manifest-declared permissions (ADR-0018). The sealed shape is untouched, so no version bump: the
  copies in each app need re-syncing, but nothing compiled against 1.0 breaks.
