# ADR-0027: Icons are bundled at build time, never fetched at render time

**Status:** Accepted · **Date:** 2026-08-25 · **Deciders:** Matt Adcock (ITM 26/27)

## Context

`@nuxt/icon`, which Nuxt UI registers for us, resolves an icon it cannot find locally by fetching
it from the Iconify API at render time. A Cloudflare Worker cannot reach that host, so the fetch
fails, the component renders nothing, and a warning is logged.

This had been happening on every server-rendered page in the estate, unnoticed, because the failure
is a warning rather than an error and the icon reappears once the client hydrates. Workers
Observability for the seven days to 2026-08-25 recorded **26,980 of these warnings from stage-door
alone**, against 42,150 requests. The six most frequent were `simple-icons:google`, `lucide:eye`,
`lucide:mail`, `lucide:circle-user-round`, `lucide:user-round-plus` and `lucide:key-round`: the
Google button, the password reveal, the email field, the avatar, the register link and the passkey
icon. In other words the login page, which is the most visited unauthenticated page in the estate.

Two things made the cause hard to see:

- Installing `@iconify-json/*` is **not sufficient**. `rooms` already depended on
  `@iconify-json/lucide` and `@iconify-json/simple-icons` and still logged the same failures. The
  collections supply the data; they do not by themselves put an icon into the bundle.
- The scan that does bundle them only reads `.vue`, `.jsx`, `.tsx`, `.md`, `.mdc`, `.mdx`, `.yml`
  and `.yaml` by default, and only matches names written as literal strings. Icons named in a `.ts`
  file, such as a list of navigation links, are missed.

## Decision

Every app bundles the icons it uses at build time and never depends on a runtime fetch.

Concretely, in each app: install the `@iconify-json/*` collections it draws from, and configure

```ts
icon: {
  clientBundle: {
    scan: { globInclude: ['**/*.{vue,jsx,tsx,md,mdc,mdx,yml,yaml,ts,js}'] },
    icons: [ ... ],
  },
},
```

The widened `globInclude` is deliberate: it replaces the default list rather than adding to it, so
the default extensions are repeated and `ts` and `js` added, which is what catches icons named in
navigation configuration.

The explicit `icons` array carries what the scan cannot see: **Nuxt UI renders a number of icons
from inside the module itself**, `lucide:eye` and `lucide:eye-off` for the password reveal among
them, and no scan of our own source will ever find those. They are listed by name.

## Consequences

- An icon whose name is built at runtime, or assembled dynamically as `` `i-lucide-${name}` ``,
  still cannot be bundled and will still fail on a Worker. Do not name icons dynamically.
- Adding an icon from a collection the app does not yet depend on means adding that collection.
  The symptom of forgetting is a missing icon in the server-rendered HTML, not a build failure.
- Upgrading Nuxt UI can introduce a new internally-rendered icon, which would fail the same way.
  The check is cheap: run the app, load the busy pages, and confirm the log carries no
  `[Icon] failed to load icon` line.
- The client bundle grows by the icons actually used. That is the trade, and it is the right way
  round: an icon that is present is worth more than a few kilobytes saved.
