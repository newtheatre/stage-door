#!/usr/bin/env bash
# Export the two production source databases (read-only) for the migration.
# The live Proscenium DB is the one NAMED proscenium-testing — see README.md.
set -euo pipefail
cd "$(dirname "$0")/../.."

mkdir -p .data/migrate

echo "Exporting proscenium (live db is named 'proscenium-testing')…"
npx wrangler d1 export proscenium-testing --remote --output .data/migrate/proscenium.sql

echo "Exporting rooms…"
npx wrangler d1 export rooms --remote --output .data/migrate/rooms.sql

echo "Done. Exports in .data/migrate/ (gitignored — contains personal data)."
