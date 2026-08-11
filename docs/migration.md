# Migration: merging Proscenium & rooms users

The one-off migration that populated the auth DB from the two legacy user tables. **Historical after cutover** — kept because it explains why the data looks the way it does (preserved ids, `legacy_ids`, guest rows), and as the template for migrating any future app in (ticketing, eventually).

Scripts live in `scripts/migrate/` and are runnable end-to-end against local copies. **The rehearsal is mandatory**: run against exported copies, commit the output counts to the PR, and only then run for real.

## Source facts that shaped the rules

- Both apps hash with nuxt-auth-utils' scrypt (`@adonisjs/hash`, PHC strings) → hashes copy over verbatim, nobody resets a password.
- Proscenium: nanoid text ids; `users.password` **nullable** (guest/shadow rows); `email_verified` exists; `reservations.user_id` NOT NULL/`restrict`.
- rooms: UUID text ids; `password_hash` non-null; **no** verification concept; `bookings.user_id` nullable/`SetNull`; open registration meant anyone may hold an account.
- Emails unique in both DBs → lowercased email is the join key.

## Merge rules (keyed on `lower(email)`)

1. **In both** → Proscenium row wins; its id becomes canonical. Password: Proscenium's hash, unless NULL (shadow) and rooms has one — then rooms's hash. `email_verified` from Proscenium. Name: from the more recently active account. rooms UUID recorded in `legacy_ids`.
2. **Proscenium only** → copied verbatim (id preserved). Shadow rows stay shadow.
3. **rooms only** → copied with the rooms UUID **kept as the canonical id** (opaque strings; keeping it makes the rooms data-fix a no-op for these users). `email_verified = false`.
4. **Roles** → `user_roles` rows become `proscenium:ADMIN|MANAGER|BOX_OFFICE`; rooms `ADMIN` → `rooms:ADMIN`; rooms `STANDARD` → no role (logged-in suffices, matching prior behaviour). `auth:ADMIN` granted explicitly to the ITM.
5. **Excluded** → in-flight verification/reset tokens (short-lived); rooms notification preferences (app data, stays in rooms); Proscenium's five known-password seed accounts (dropped; real admin accounts re-created cleanly).
6. **`legacy_ids` written for every migrated row**, both sources, even where ids were preserved.

## Per-app data fixes

- **rooms**: for users merged with a Proscenium identity, `UPDATE bookings SET user_id = <canonical>` (and `push_subscriptions` likewise); then the local users table becomes the thin mirror (id, email, name + notification columns).
- **Proscenium**: ids unchanged, `reservations` untouched; Drizzle migration slims `users` and drops `user_roles`, `email_verifications`, `password_resets`.

## Verification gate (asserted by script, not eyeballed)

- Distinct lowercased emails across both sources == auth `users` count.
- Zero `bookings.user_id` / `reservations.user_id` values without a matching mirror row.
- Every source row has a `legacy_ids` entry.
- Random sample of hashes byte-identical to source; one **real login** (the ITM's own account, old password) succeeds against the merged DB in rehearsal.
- Role counts: per-namespace totals equal source role counts (minus excluded seeds).

## Cutover order & window

Deploy auth service → run migration → deploy rooms integration → deploy Proscenium integration, keeping the migration-to-cutover window to hours (legacy apps authenticate against increasingly stale tables until they flip). Done in a quiet week before term. Rollback before an app flips = nothing happened (legacy tables untouched); rollback after = redeploy the app's previous release, whose old tables are still present until the post-verification cleanup migration removes them.

## Template for future app migrations (e.g. ticketing)

Same shape: export → map users by lowercased email into `users` (create-or-match), write `legacy_ids` (`source: 'ticketing'`), convert roles to `ticketing:*`, rewrite the app's user FKs to canonical ids, slim to a mirror, integrate per [integrating-an-app.md](integrating-an-app.md). The only hard thinking each time is the password-hash compatibility question — if the source scheme isn't scrypt-PHC, migrate with `password = NULL` + a "set a password" email campaign, or verify-then-rehash on first login.
