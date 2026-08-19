# Integrating an App ("piggybacking" guide)

You're building a new NNT app — or retrofitting an old one — and want login, SSO, and roles without building any of it. This is the complete checklist. Proscenium ([PR #103](https://github.com/newtheatre/proscenium/pull/103)) and rooms ([PR #2](https://github.com/newtheatre/rooms/pull/2)) are the reference integrations — read their diffs alongside this doc; photos is the expected next reader.

**Prerequisites:** the app runs on a `*.newtheatre.org.uk` subdomain as a Cloudflare Worker, is a Nuxt/Nitro app (anything h3-based works), and you can add worker secrets. If your app is *not* Nuxt: everything still applies — you just need an iron-compatible unseal of the `nnt-session` cookie; talk to the ITM before going down that road.

## Step 0 — Ask for the two credentials

From the ITM (or via [operations.md](operations.md) if that's you):

1. **The session seal secret** — you do not get a copy. It lives in the account
   Secrets Store and you bind it into your worker ([ADR-0016](decisions/0016-estate-secrets-in-secrets-store.md)); see Step 1b. Treat the
   binding as the master key it is.
2. **A service token** for your app (`nnt_svc_…`), if your app needs server-to-server calls (shadow users, hooks). Set as worker secret **`NUXT_AUTH_SERVICE_TOKEN`** — the `NUXT_` prefix is load-bearing, since Nuxt only maps `NUXT_*` env onto `runtimeConfig`. A secret named `AUTH_SERVICE_TOKEN` is silently ignored; that cost us a broken guest checkout between the Phase 5 cutover and Phase 7.

## Step 1 — Install the shared bits

```bash
bun add nuxt-auth-utils
```

Then copy the session contract into your app. `packages/auth-types/index.ts` in this repo is the
source of truth; it is **not** published to a registry, so each consumer app carries a verbatim copy:

```bash
cp ../stage-door/packages/auth-types/index.ts shared/utils/nntAuth.ts
```

Head the copy "DO NOT EDIT HERE — change it in stage-door and re-copy", as Proscenium, rooms and
rehearsal all do. `shared/utils/` is a Nuxt auto-import directory, so `hasRole` and `hasAnyRole`
need no import.

`nuxt.config.ts` — the session block must match [session-contract.md](session-contract.md) exactly. The cookie domain is **production-only** (localhost has no subdomains — a domain'd cookie breaks local dev), so split it with `$production`:

```ts
export default defineNuxtConfig({
  modules: ['nuxt-auth-utils'],
  $production: {
    runtimeConfig: {
      session: {
        name: 'nnt-session',
        password: '',
        maxAge: 60 * 60 * 24 * 30,
        cookie: { domain: '.newtheatre.org.uk', sameSite: 'lax', secure: true },
      },
    },
  },
  runtimeConfig: {
    session: { name: 'nnt-session', password: '', maxAge: 60 * 60 * 24 * 30 },
    public: { authBaseURL: 'https://auth.newtheatre.org.uk' },
  },
})
```

## Step 1b — Bind the seal secret

`password: ''` above is filled in at runtime from the Secrets Store. Two pieces,
both required — a binding with no plugin leaves the password empty, and every
session read returns 500.

`nuxt.config.ts`, inside `nitro.cloudflare.wrangler`:

```ts
secrets_store_secrets: [
  {
    binding: 'SESSION_PASSWORD',
    store_id: 'fdfe08b6b01f498fbddbc08c2891cadb',
    secret_name: 'NUXT_SESSION_PASSWORD',
  },
],
```

Then copy `server/plugins/0.secrets-store.ts` from any estate app verbatim. It
reads the binding on Nitro's `request` hook and writes it into
`runtimeConfig.session.password` before your handlers run — necessary because a
Secrets Store binding is an object with an async `get()`, while nuxt-auth-utils
reads the password synchronously.

Three ways to get this wrong. All three fail silently, and none of them looks
like a secrets problem from the outside — the app simply never sees a logged-in
user.

**1. Do not name the binding `NUXT_SESSION_PASSWORD`.** On Workers `process.env`
is a proxy over the bindings object and Nitro copies `NUXT_*` keys straight onto
the matching `runtimeConfig` path, so the prefix would put the binding *object*
where the password belongs.

**2. Do not also set `NUXT_SESSION_PASSWORD` as a worker secret.** It does not
duplicate the store value, it *overrides* it: nuxt-auth-utils resolves the
password as `defu({ password: process.env.NUXT_SESSION_PASSWORD },
runtimeConfig.session)` and `defu` gives its first argument priority. The plugin
logs a loud error if it sees both.

**3. Do not rename the file.** The `0.` prefix orders it ahead of your other
plugins: Nitro sorts `server/plugins/` by filename, and nuxt-auth-utils memoises
the session password on the *first* session read an isolate performs. A plugin
that reads the session before this one runs pins the empty default password for
that isolate's whole life. Server middleware is fine — it runs after all plugin
`request` hooks.

There is no binding in dev, where the plugin no-ops and the password comes from
`.env` ([development.md](development.md)). The upshot is that this step is only
exercised in production.

**Checking it worked — do not trust the status code.** h3's `getSession`
swallows unseal failures, so `/api/_auth/session` returns `200` with an
anonymous `{ id }` whether the password is right, wrong, or empty. A 200 proves
only that the password resolved to *something*. Log in for real, and confirm
the response body has a **`user` key**.

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

Rules (contract §rules): read-only; ignore roles outside your namespace; ignore unknown fields. **Login/account links point at the auth service:**

```
https://auth.newtheatre.org.uk/login?redirect=<url-encoded current page>
https://auth.newtheatre.org.uk/account          ← "manage account" link
```

**Logout** is a same-site form POST to the redirecting `/logout` route — a cross-origin `fetch` would need CORS the service deliberately doesn't have, while a form POST carries the cookie (SameSite=Lax compares *site*, not origin) and bounces back:

```ts
function logout() {
  const form = document.createElement('form')
  form.method = 'POST'
  form.action = `${authBaseURL}/logout?redirect=${encodeURIComponent(window.location.origin)}`
  document.body.appendChild(form)
  form.submit()
}
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

Practicalities from the reference integrations: debounce the upsert (once a minute per user per isolate is plenty — see rooms's `ensureLocalUser`), and run it from one central place (rooms: the global middleware; Proscenium: the authorization-resolver plugin). If you need to *query* by role locally (e.g. "notify all admins"), you may keep a **derived cache column** refreshed from the session on each upsert (rooms's `is_rooms_admin`) — but never gate access on it; the session is the authority and the cache self-heals within the staleness window.

## Step 5 — Privileged-route staleness check

Anywhere you honour a role, enforce the 15-minute refresh (client route middleware shown; do the equivalent server-side for API routes):

```ts
// app/middleware/admin.ts — check staleness BEFORE the role: a stale session
// may be missing a freshly-granted role, and an expired one must re-read
// before being turned away.
export default defineNuxtRouteMiddleware((to) => {
  const { loggedIn, user, session } = useUserSession()
  const target = `${useRequestURL().origin}${to.fullPath}`
  if (!loggedIn.value)
    return navigateTo(`https://auth.newtheatre.org.uk/login?redirect=${encodeURIComponent(target)}`, { external: true })
  if (isStale(session.value))
    return navigateTo(
      `https://auth.newtheatre.org.uk/api/session/refresh?redirect=${encodeURIComponent(target)}`,
      { external: true },
    )
  if (!hasRole(user.value, 'myapp', 'ADMIN')) return navigateTo('/')
})
```

Server-side, reject stale role-holding sessions with a 401 carrying `data: { stale: true }` so callers can distinguish "log in" from "refresh" (see rooms's `requireAdmin` / Proscenium's `getVerifiedSessionUser`). Sessions with no roles in your namespace need no staleness check — never put the auth service on your public request path.

## Step 6 — Role namespace

Pick a short lowercase namespace (usually the repo name) and define your roles as `namespace:ROLE`. Tell the ITM; they grant them in the auth admin UI. There is no code registration step — but do add **role definitions** at `auth.newtheatre.org.uk/admin/roles` (description + default expiry; most app roles want `end of committee year`) so granting is dropdown-driven rather than typed (ADR-0011).

### Which namespaces exist

`auth.newtheatre.org.uk/admin/apps` lists every registered app and its namespace, and
`/admin/roles` lists every defined role. Those screens are the answer; this document
deliberately no longer carries a copy for someone to forget to update (ADR-0017).

Two namespaces have no app behind them and will not appear under Apps:

- `auth` (`ADMIN`) — this service's own admin, deliberately scarce.
- `ticketing` (`ADMIN`, `MANAGER`, `BOX_OFFICE`) — **dormant.** Held by people the
  legacy-ticketing import brought in (docs/migration.md rule 4); no app reads them.
  When ticketing rebuilds on this stack they are its starting role set. Until then
  they grant nothing anywhere.

## Step 7 — Server-to-server (optional)

Guest/shadow users (only if you take bookings from people who aren't logged in):

```ts
const res = await $fetch('https://auth.newtheatre.org.uk/api/users/shadow', {
  method: 'POST',
  headers: { Authorization: `Bearer ${useRuntimeConfig().authServiceToken}` },
  body: { email, name },
})
await ensureLocalUser({ id: res.id, email, name })
// … create your booking FK'd to res.id
```

If the auth service is unreachable, fail the operation with a retry message — do not create local-only users.

## Step 8 — GDPR hooks (required if you store any personal data)

Implement the three hook endpoints from [api-reference.md](api-reference.md#app-hooks) — `export`, `anonymise`, `last-activity` — authenticated by your service token. The ITM then adds your registry row at `auth.newtheatre.org.uk/admin/apps` (name, role namespace, base URL, hooks on). There is no source change in the auth service: registering an app needs no deploy of it (ADR-0017). (The fourth hook is `merge` (ADR-0015): `POST /api/_hooks/auth/merge { fromUserId, toUserId, dryRun? }` re-points every user-referencing column in your database onto `toUserId` and deletes the losing mirror row, returning `{ ok: true, notMirrored, counts }` — with `dryRun: true`, the counts only, writing nothing. Idempotent, like the others: stage-door calls every app before changing anything central, and retries the whole merge if any app fails. Don't miss indirect references (staff-attribution columns, "issued by" fields) — proscenium's implementation re-points four columns, not one.) Ship them with the integration even though the auth-service callers arrive in Phase 7; they're small, and retrofitting them across the estate later is exactly the kind of debt this service exists to end.

## Step 9 — Local development

See [development.md](development.md): you'll run without the cookie domain, with a dev seed user, and (optionally) against a locally-run auth service. Never point local dev at the production auth DB.

The shipped pattern is a `/dev-login` server route — the single sanctioned exception to "apps never write the session" — guarded by `import.meta.dev` so it does not exist in production builds:

```ts
// server/routes/dev-login.get.ts
export default defineEventHandler(async (event) => {
  if (!import.meta.dev) throw createError({ statusCode: 404 })
  const now = Date.now()
  await setUserSession(event, {
    // `@dev.newtheatre.org.uk`, matching the stage-door seed. Never a reserved
    // TLD (`.test`, `.invalid`, `example.com`): `isUndeliverableEmail` treats
    // those as anonymised placeholders, so the fixture user disappears from
    // /admin and is blocked from register/claim/forgot — see development.md.
    user: { id: 'dev-admin', email: 'dev-admin@dev.newtheatre.org.uk', name: 'Dev Admin', verified: true, guest: false, roles: ['myapp:ADMIN'] },
    loggedInAt: now, refreshedAt: now, epoch: 0,
  })
  return sendRedirect(event, '/', 302)
})
```

Your app middleware then sends logged-out visitors to `/dev-login` in dev and the hosted login in production (see the reference integrations).

## Integration acceptance checklist

- [ ] Session config byte-identical to the contract; `SESSION_PASSWORD` binding + `server/plugins/0.secrets-store.ts` both present, no `NUXT_SESSION_PASSWORD` worker secret, and a **real login** on the deployed worker returns a session body with a `user` key (a 200 alone proves nothing — see §1b)
- [ ] No `setUserSession`/`clearUserSession`/`hashPassword` calls anywhere in the app
- [ ] No local auth pages, credential columns, or role-editing UI remain
- [ ] Global middleware fails closed; public paths are an explicit list
- [ ] Privileged routes enforce the 15-minute staleness refresh (test: demote a user, watch access die)
- [ ] Mirror upsert idempotent (if applicable)
- [ ] GDPR + merge hooks implemented + registered; erasure dry-run tested
- [ ] `docs/integrating-an-app.md` role-namespace table updated
- [ ] ITM has issued the service token and recorded it in the password manager
