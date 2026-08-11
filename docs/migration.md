# Migration: merging Proscenium & rooms users

The one-off migration that populated the auth DB from the two legacy user tables. **Historical after cutover** — kept because it explains why the data looks the way it does (preserved ids, `legacy_ids`, guest rows), and as the template for migrating any future app in (ticketing, eventually).

Scripts live in `scripts/migrate/` and are runnable end-to-end against local copies (`export.sh` → `rehearse.sh`; see that folder's README). **The rehearsal is mandatory**: run against exported copies, commit the output counts to the PR, and only then run for real. First full rehearsal against production exports passed all gate assertions on 2026-08-11 (639 users: 605 Proscenium-only, 21 rooms-only, 13 merged; 4 case-folds; 656 legacy ids).

## Source facts that shaped the rules

- Both apps hash with nuxt-auth-utils' scrypt (`@adonisjs/hash`, PHC strings) → hashes copy over verbatim, nobody resets a password.
- Proscenium: nanoid text ids; `users.password` **nullable** (guest/shadow rows); `email_verified` exists; `reservations.user_id` NOT NULL/`restrict`.
- rooms: UUID text ids; `password_hash` non-null; **no** verification concept; `bookings.user_id` nullable/`SetNull`; open registration meant anyone may hold an account.
- Emails unique in both DBs → lowercased email is the join key. **Production caveat (found 2026-08-11): Proscenium's uniqueness is case-sensitive** — four people guest-booked twice with different capitalisation, so lowercasing collides. See merge rule 0.
- The live Proscenium database is the one *named* `proscenium-testing` in the Cloudflare dashboard (id `c4200074…`, the id the worker binds); the DB named `proscenium` is a copy. Export by the id-verified name.

## Merge rules (keyed on `lower(email)`)

0. **Intra-source case-duplicate fold (Proscenium)** → rows whose emails differ only by case are one person: winner = earliest-created row (id preserved), name from the most recently active row, password/verified = any non-null/max across the group. The generated `proscenium-fixes.sql` re-points the losers' reservations to the winner and deletes the loser rows — safe in the live DB at migration time. Every folded id still gets a `legacy_ids` entry. (All four production cases are shadow rows; the rule is written generally.)
1. **In both** → Proscenium row wins; its id becomes canonical. Password: Proscenium's hash, unless NULL (shadow) and rooms has one — then rooms's hash. `email_verified` from Proscenium. Name: from the more recently active account. rooms UUID recorded in `legacy_ids`.
2. **Proscenium only** → copied verbatim (id preserved). Shadow rows stay shadow.
3. **rooms only** → copied with the rooms UUID **kept as the canonical id** (opaque strings; keeping it makes the rooms data-fix a no-op for these users). `email_verified = false`.
4. **Roles** → `user_roles` rows become `proscenium:ADMIN|MANAGER|BOX_OFFICE`; rooms `ADMIN` → `rooms:ADMIN`; rooms `STANDARD` → no role (logged-in suffices, matching prior behaviour). `auth:ADMIN` granted explicitly to the ITM.
5. **Excluded** → in-flight verification/reset tokens (short-lived); rooms notification preferences (app data, stays in rooms). Proscenium's five known-password seed accounts: only `admin@newtheatre.org.uk` survives in production and it owns reservations (NOT NULL/`restrict`), so instead of being dropped it is migrated **neutralised** — password NULL, disabled, unverified, no roles. Its `proscenium:ADMIN` role is re-granted explicitly to the ITM's real account alongside `auth:ADMIN` (rule 4). **After cutover the ITM must use their own account, not admin@** — it will no longer log in anywhere.
6. **`legacy_ids` written for every migrated row**, both sources, even where ids were preserved.

## Per-app data fixes

- **Proscenium**: `proscenium-fixes.sql` (case-fold re-point + loser deletion, rule 0) runs in the live DB at migration time; otherwise ids unchanged, `reservations` untouched. The Phase 5 Drizzle migration slims `users` and drops `user_roles`, `email_verifications`, `password_resets`.
- **rooms**: `rooms-fixes.sql` re-points `bookings`/`push_subscriptions` for users merged with a Proscenium identity — it runs *inside* rooms's Phase 4 integration migration, after the users table is slimmed to the mirror shape and mirror rows exist for the canonical ids; then the local users table is the thin mirror (id, email, name + notification columns).

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
