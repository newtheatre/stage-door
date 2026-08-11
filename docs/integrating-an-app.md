# Integrating an App ("piggybacking" guide)

You're building a new NNT app — or retrofitting an old one — and want login, SSO, and roles without building any of it. This is the complete checklist. Proscenium and rooms are the reference integrations; photos is the expected next reader.

**Prerequisites:** the app runs on a `*.newtheatre.org.uk` subdomain as a Cloudflare Worker, is a Nuxt/Nitro app (anything h3-based works), and you can add worker secrets. If your app is *not* Nuxt: everything still applies — you just need an iron-compatible unseal of the `nnt-session` cookie; talk to the ITM before going down that road.

## Step 0 — Ask for the two credentials

From the ITM (or via [operations.md](operations.md) if that's you):

1. **`NUXT_SESSION_PASSWORD`** — the shared session seal secret. Set it as a worker secret. Treat it like the master key it is: it never goes in code, config files, or CI variables in plaintext.
2. **A service token** for your app (`nnt_svc_…`), if your app needs server-to-server calls (shadow users, hooks). Set as worker secret `AUTH_SERVICE_TOKEN`.

## Step 1 — Install the shared bits

```bash
bun add nuxt-auth-utils @newtheatre/auth-types
```

`nuxt.config.ts` — the session block must match [session-contract.md](session-contract.md) exactly:

```ts
export default defineNuxtConfig({
  modules: ['nuxt-auth-utils'],
  runtimeConfig: {
    session: {
      name: 'nnt-session',
      password: '',
      maxAge: 60 * 60 * 24 * 30,
      cookie: { domain: '.newtheatre.org.uk', sameSite: 'lax', secure: true },
    },
  },
})
```

## Step 2 — Read sessions; never write them

```ts
// server route
const { user } = await requireUserSession(event)          // 401 if not logged in
if (!hasRole(user, 'myapp', 'ADMIN')) throw createError({ statusCode: 403 })
```

```ts
// client
const { loggedIn, user } = useUserSession()
```

Rules (contract §rules): read-only; ignore roles outside your namespace; ignore unknown fields. **Login/logout/register links point at the auth service:**

```
https://auth.newtheatre.org.uk/login?redirect=<url-encoded current page>
https://auth.newtheatre.org.uk/account          ← "manage account" link
POST https://auth.newtheatre.org.uk/api/auth/logout
```

Delete any local login/register/reset pages and credential columns. Apps do not store passwords. Ever again.

## Step 3 — Global auth middleware (fail closed)

Add `server/middleware/auth.ts` so protection is opt-*out*, not opt-in (this was rooms's biggest pre-integration footgun):

```ts
const PUBLIC = [/^\/$/, /^\/api\/health$/, /^\/docs\//, /* … */]

export default defineEventHandler(async (event) => {
  if (PUBLIC.some(re => re.test(event.path))) return
  const session = await requireUserSession(event)        // 401 if absent
  await ensureLocalUser(session.user)                     // Step 4
  event.context.user = session.user
})
```

Public apps (like Proscenium's whats-on pages) invert this — default public, explicit guards on protected routes — but must still route every protected handler through one shared guard, not per-handler copy-paste.

## Step 4 — Local user mirror (only if you have user FKs)

If your schema references users, keep a thin mirror table `users(id TEXT PK, email TEXT, name TEXT)` and upsert from the session:

```ts
export async function ensureLocalUser(u: User) {
  await db.insert(users)
    .values({ id: u.id, email: u.email, name: u.name })
    .onConflictDoUpdate({ target: users.id, set: { email: u.email, name: u.name } })
}
```

FK against `users.id`. Never invent user rows with ids the auth service didn't issue (exception: `POST /api/users/shadow`, below). If you don't need per-user rows, skip this step entirely and just use `user.id` from the session.

## Step 5 — Privileged-route staleness check

Anywhere you honour a role, enforce the 15-minute refresh (client route middleware shown; do the equivalent server-side for API routes):

```ts
// app/middleware/admin.ts
export default defineNuxtRouteMiddleware(() => {
  const { user, session } = useUserSession()
  if (!user.value || !hasRole(user.value, 'myapp', 'ADMIN')) return navigateTo('/')
  if (isStale(session.value, 15 * 60_000))
    return navigateTo(
      `https://auth.newtheatre.org.uk/api/session/refresh?redirect=${encodeURIComponent(useRequestURL().href)}`,
      { external: true },
    )
})
```

## Step 6 — Role namespace

Pick a short lowercase namespace (usually the repo name) and define your roles as `namespace:ROLE`. Tell the ITM; they grant them in the auth admin UI. There is no code registration step.

### Role namespaces (current)

| Namespace | Roles | Meaning |
|---|---|---|
| `auth` | `ADMIN` | Auth service admin (ITM + continuity holder — deliberately scarce) |
| `proscenium` | `ADMIN`, `MANAGER`, `BOX_OFFICE` | Site/box-office tiers (semantics per Proscenium's ability layer) |
| `rooms` | `ADMIN` | Room-booking admin; logged-in is sufficient for booking requests |
| `photos` | `ADMIN`, `UPLOADER` | Per the photos platform plan (granted when photos ships) |

Update this table when you add a namespace.

## Step 7 — Server-to-server (optional)

Guest/shadow users (only if you take bookings from people who aren't logged in):

```ts
const res = await $fetch('https://auth.newtheatre.org.uk/api/users/shadow', {
  method: 'POST',
  headers: { Authorization: `Bearer ${process.env.AUTH_SERVICE_TOKEN}` },
  body: { email, name },
})
await ensureLocalUser({ id: res.id, email, name })
// … create your booking FK'd to res.id
```

If the auth service is unreachable, fail the operation with a retry message — do not create local-only users.

## Step 8 — GDPR hooks (required if you store any personal data)

Implement the three hook endpoints from [api-reference.md](api-reference.md#app-hooks) — `export`, `anonymise`, `last-activity` — authenticated by your service token, and register your base URL with the ITM. (A fourth hook, `merge`, arrives with the account-merge tool — [roadmap R3](roadmap.md); if you're integrating after that ships, implement it too.) Ship them with the integration even though the auth-service callers arrive in Phase 7; they're small, and retrofitting them across the estate later is exactly the kind of debt this service exists to end.

## Step 9 — Local development

See [development.md](development.md): you'll run without the cookie domain, with a dev seed user, and (optionally) against a locally-run auth service. Never point local dev at the production auth DB.

## Integration acceptance checklist

- [ ] Session config byte-identical to the contract; `NUXT_SESSION_PASSWORD` set as a worker secret
- [ ] No `setUserSession`/`clearUserSession`/`hashPassword` calls anywhere in the app
- [ ] No local auth pages, credential columns, or role-editing UI remain
- [ ] Global middleware fails closed; public paths are an explicit list
- [ ] Privileged routes enforce the 15-minute staleness refresh (test: demote a user, watch access die)
- [ ] Mirror upsert idempotent (if applicable)
- [ ] GDPR hooks implemented + registered; erasure dry-run tested
- [ ] `docs/integrating-an-app.md` role-namespace table updated
- [ ] ITM has issued the service token and recorded it in the password manager
