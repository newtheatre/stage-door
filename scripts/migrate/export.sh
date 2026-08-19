#!/usr/bin/env bash
# Export the two production source databases (read-only) for the migration.
set -euo pipefail
cd "$(dirname "$0")/../.."

mkdir -p .data/migrate

echo "Exporting proscenium…"
npx wrangler d1 export proscenium --remote --output .data/migrate/proscenium.sql

echo "Exporting rooms…"
npx wrangler d1 export rooms --remote --output .data/migrate/rooms.sql

echo "Done. Exports in .data/migrate/ (gitignored: contains personal data)."
