#!/usr/bin/env bash
# End-to-end local rehearsal: build the merged dataset, import it into a
# fresh DB created from the real Drizzle migrations, run the verification
# gate. Mandatory before the real run (docs/migration.md).
set -euo pipefail
cd "$(dirname "$0")/../.."

test -f .data/migrate/proscenium.sql || { echo "Run scripts/migrate/export.sh first."; exit 1; }

echo "== build =="
bun scripts/migrate/build.ts

echo "== fresh auth DB from real migrations =="
rm -f .data/migrate/out/rehearsal-auth.sqlite
bun -e '
import { Database } from "bun:sqlite"
import { readFileSync, readdirSync } from "node:fs"
const db = new Database(".data/migrate/out/rehearsal-auth.sqlite")
for (const f of readdirSync("server/db/migrations/sqlite").filter(f => f.endsWith(".sql")).sort()) {
  for (const stmt of readFileSync(`server/db/migrations/sqlite/${f}`, "utf8").split("--> statement-breakpoint")) {
    if (stmt.trim()) db.exec(stmt)
  }
}
db.exec(readFileSync(".data/migrate/out/auth-import.sql", "utf8"))
console.log("imported")
'

echo "== verification gate =="
bun scripts/migrate/verify.ts
