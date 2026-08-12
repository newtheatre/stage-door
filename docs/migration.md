# Migration: merging Proscenium & rooms users

The one-off migration that populated the auth DB from the two legacy user tables. **Ran for real on 2026-08-11/12; this document is now historical** — kept because it explains why the data looks the way it does (preserved ids, `legacy_ids`, guest rows), and as the template for migrating any future app in (ticketing, eventually).

Final production numbers: 9,971 users imported (605 + 9,330 legacy Proscenium-only, 21 rooms-only, 13 merged, 594 + 8,267 shadow, 3 neutralised, 4 case-folds), 9,991 legacy ids, roles `auth:ADMIN`=1 `proscenium:ADMIN`=1 `proscenium:MANAGER`=1 `rooms:ADMIN`=6 `ticketing:*`=25 (dormant). All 18 gate assertions passed against production. The ~8.3k undeliverable-domain rows were additionally `disabled` post-import (see [security.md](security.md) — the register-claim hotfix).

Scripts live in `scripts/migrate/` and are runnable end-to-end against local copies (`export.sh` → `rehearse.sh`; see that folder's README). **The rehearsal is mandatory**: run against exported copies, commit the output counts to the PR, and only then run for real. First full rehearsal against production exports passed all gate assertions on 2026-08-11 (639 users: 605 Proscenium-only, 21 rooms-only, 13 merged; 4 case-folds; 656 legacy ids).

## Source facts that shaped the rules

- Both apps hash with nuxt-auth-utils' scrypt (`@adonisjs/hash`, PHC strings) → hashes copy over verbatim, nobody resets a password.
- Proscenium: nanoid text ids; `users.password` **nullable** (guest/shadow rows); `email_verified` exists; `reservations.user_id` NOT NULL/`restrict`.
- rooms: UUID text ids; `password_hash` non-null; **no** verification concept; `bookings.user_id` nullable/`SetNull`; open registration meant anyone may hold an account.
- Emails unique in both DBs → lowercased email is the join key. **Production caveat (found 2026-08-11): Proscenium's uniqueness is case-sensitive** — four people guest-booked twice with different capitalisation, so lowercasing collides. See merge rule 0.
- Two identical-looking Proscenium databases exist (`proscenium` and `proscenium-testing`); the worker originally bound the `-testing` one and was switched to `proscenium` on 2026-08-11. The live DB is whichever id the Proscenium worker binds — verify before exporting.

## Merge rules (keyed on `lower(email)`)

0. **Intra-source case-duplicate fold (Proscenium)** → rows whose emails differ only by case are one person: winner = earliest-created row (id preserved), name from the most recently active row, password/verified = any non-null/max across the group. The generated `proscenium-fixes.sql` re-points the losers' reservations to the winner and deletes the loser rows — safe in the live DB at migration time. Every folded id still gets a `legacy_ids` entry. (All four production cases are shadow rows; the rule is written generally.)
1. **In both** → Proscenium row wins; its id becomes canonical. Password: Proscenium's hash, unless NULL (shadow) and rooms has one — then rooms's hash. `email_verified` from Proscenium. Name: from the more recently active account. rooms UUID recorded in `legacy_ids`.
2. **Proscenium only** → copied verbatim (id preserved). Shadow rows stay shadow.
3. **rooms only** → copied with the rooms UUID **kept as the canonical id** (opaque strings; keeping it makes the rooms data-fix a no-op for these users). `email_verified = false`.
4. **Roles** → `user_roles` rows of users that existed before the 2026-08-11 legacy-ticketing import become `proscenium:ADMIN|MANAGER|BOX_OFFICE`; role rows held by users the legacy import created become **dormant `ticketing:*` roles** instead (plan §11 — granting live Proscenium admin to alumni/placeholder accounts from the old site would be a security regression; upgrade individuals via the auth admin UI where wanted). The pre-import id set lives in `.data/migrate/pre-legacy-proscenium-ids.json` (622 ids, extracted from the pre-import build output). rooms `ADMIN` → `rooms:ADMIN`; rooms `STANDARD` → no role. `auth:ADMIN` granted explicitly to the ITM.
5. **Excluded** → in-flight verification/reset tokens (short-lived); rooms notification preferences (app data, stays in rooms). Proscenium's five known-password seed accounts: only `admin@newtheatre.org.uk` survives in production and it owns reservations (NOT NULL/`restrict`), so instead of being dropped it is migrated **neutralised** — password NULL, disabled, unverified, no roles. Its `proscenium:ADMIN` role is re-granted explicitly to the ITM's real account alongside `auth:ADMIN` (rule 4). **After cutover the ITM must use their own account, not admin@** — it will no longer log in anywhere. The same neutralisation applies to passworded accounts on undeliverable domains (`@example.com`, `.invalid`, `.test`) — test artifacts from the legacy import that could never receive a reset email (found live: `manager@example.com`, `trainer@example.com`).
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
