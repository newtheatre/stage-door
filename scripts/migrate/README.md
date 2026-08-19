# One-off user migration (docs/migration.md)

Merges Proscenium and rooms users into the auth DB. **Rehearse before running
for real**: the rehearsal output counts go in the PR description.

```bash
# 1. Export production sources (read-only; needs wrangler auth)
./scripts/migrate/export.sh

# 2. Rehearse: build + import into a fresh local DB + verify, end to end
./scripts/migrate/rehearse.sh

# 3. Real run (cutover window only: docs/migration.md#cutover-order--window)
npx wrangler d1 export auth --remote --output .data/migrate/backup-auth-$(date +%F).sql
npx wrangler d1 execute auth --remote --file .data/migrate/out/auth-import.sql
bun scripts/migrate/verify.ts --remote          # gate against production
# rooms-fixes.sql runs inside rooms's own integration migration (Phase 4).
# see the header comment in the generated file.
```

Everything lands in `.data/migrate/` (gitignored: the exports are personal
data and must never be committed). `build.ts` is deterministic: same inputs,
same output SQL.

## Gotchas discovered against production (2026-08-11)

- There are two identical-looking Proscenium databases (`proscenium`, id
  `01a75263…`, and `proscenium-testing`, id `c4200074…`). The live one was
  originally `proscenium-testing`; the ITM switched the worker to the
  `proscenium`-named DB on 2026-08-11 and `export.sh` exports that one.
  If in doubt, the live DB is whichever id the Proscenium worker's config
  binds: verify before exporting.
- Only one of Proscenium's five known-password seed accounts survives in
  production: `admin@newtheatre.org.uk`, and it owns 2 reservations, so it
  cannot be dropped (`reservations.user_id` is NOT NULL/`restrict`). It is
  migrated **neutralised**: password NULL, disabled, no roles, unverified.
- Proscenium timestamps come in two formats (SQLite `current_timestamp` and
  ISO-8601): `build.ts` parses both; everything is stored as epoch ms.
