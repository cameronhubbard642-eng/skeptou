#!/usr/bin/env bash
#
# phronesis-d1-reset.sh — export + clear the phronesis D1 (`skeptou-op`).
#
# Written 2026-08-18 for the qualified-blank-slate reset, but NEVER RUN: wrangler's
# OAuth had expired, so that reset was carried out through the Cloudflare D1 MCP
# instead (see archive/README.md). Retained as a guarded, re-runnable utility for
# any future clear.
#
#   export CLOUDFLARE_API_TOKEN=...      # needs D1:Edit on account 0eac870e...
#   ./scripts/phronesis-d1-reset.sh
#
# DESTRUCTIVE. It exports first, verifies the dump, then empties the database.
#
# ── SAFETY ───────────────────────────────────────────────────────────────────
# A SEPARATE Glossolalia D1 (2c8387bb-9ce3-46a6-9f06-c1d8ec5b5537) backs Cam's
# LIVE Taller de Traducción / Übersetzungswerkstatt apps. This script refuses to
# run unless the resolved database UUID is exactly phronesis's, and aborts loudly
# if it ever sees the Glossolalia UUID.
#
set -euo pipefail

DB_NAME="skeptou-op"
EXPECT_UUID="6321abe6-ed91-4577-8d82-c9dbf688795c"
FORBIDDEN_UUID="2c8387bb-9ce3-46a6-9f06-c1d8ec5b5537"   # Glossolalia — NEVER touch

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MODULE_DIR="$REPO_ROOT/modules/phronesis"
ARCHIVE_DIR="$REPO_ROOT/archive"
STAMP="$(date +%Y-%m-%d)"
DUMP="$ARCHIVE_DIR/phronesis-d1-dump-${STAMP}.sql"

cd "$MODULE_DIR"
mkdir -p "$ARCHIVE_DIR"

if [ -z "${CLOUDFLARE_API_TOKEN:-}" ]; then
  echo "FATAL: CLOUDFLARE_API_TOKEN is not set. Refusing to run." >&2
  exit 1
fi

# ── Guard 1: resolve the UUID and assert it is phronesis's ───────────────────
echo "==> Resolving $DB_NAME ..."
INFO="$(npx wrangler d1 info "$DB_NAME" --json)"
UUID="$(printf '%s' "$INFO" | jq -r '.uuid // .database_id // empty')"

if [ -z "$UUID" ]; then
  echo "FATAL: could not resolve a UUID for $DB_NAME. Aborting." >&2
  exit 1
fi
if [ "$UUID" = "$FORBIDDEN_UUID" ]; then
  echo "FATAL: resolved the GLOSSOLALIA database ($UUID). ABORTING — never touch this." >&2
  exit 1
fi
if [ "$UUID" != "$EXPECT_UUID" ]; then
  echo "FATAL: $DB_NAME resolved to $UUID, expected $EXPECT_UUID." >&2
  echo "       Do not guess. Stop and reconcile against the CF dashboard." >&2
  exit 1
fi
echo "    OK — $DB_NAME = $UUID (phronesis)"

# ── Step 1: export (backup) ──────────────────────────────────────────────────
echo "==> Exporting to $DUMP ..."
npx wrangler d1 export "$DB_NAME" --remote --output "$DUMP"

if [ ! -s "$DUMP" ]; then
  echo "FATAL: dump is empty or missing. Refusing to clear anything." >&2
  exit 1
fi
echo "    dump: $(wc -c < "$DUMP") bytes, $(wc -l < "$DUMP") lines"
echo "    sha256: $(shasum -a 256 "$DUMP" | cut -d' ' -f1)"

# ── Step 2: enumerate and drop every user object ─────────────────────────────
echo "==> Enumerating objects ..."
npx wrangler d1 execute "$DB_NAME" --remote --json \
  --command "SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name;" \
  | tee "$ARCHIVE_DIR/phronesis-d1-objects-before-${STAMP}.json"

DROP_SQL="$(npx wrangler d1 execute "$DB_NAME" --remote --json \
  --command "SELECT 'DROP ' || UPPER(type) || ' IF EXISTS \"' || name || '\";' AS stmt
             FROM sqlite_master
             WHERE name NOT LIKE 'sqlite_%'
             ORDER BY CASE type WHEN 'trigger' THEN 1 WHEN 'view' THEN 2
                                WHEN 'index' THEN 3 ELSE 4 END;" \
  | jq -r '.[0].results[].stmt')"

if [ -z "$DROP_SQL" ]; then
  echo "    database already has no user objects; nothing to drop."
else
  echo "$DROP_SQL"
  printf 'PRAGMA defer_foreign_keys = true;\n%s\n' "$DROP_SQL" > "$ARCHIVE_DIR/.phronesis-drop-${STAMP}.sql"
  echo "==> Dropping ..."
  npx wrangler d1 execute "$DB_NAME" --remote --yes --file "$ARCHIVE_DIR/.phronesis-drop-${STAMP}.sql"
  rm -f "$ARCHIVE_DIR/.phronesis-drop-${STAMP}.sql"
fi

# ── Step 3: re-apply committed migrations for a clean empty schema ───────────
# Drop this step if the architecture redo replaces migrations/ wholesale;
# then the database simply stays object-free until new migrations land.
echo "==> Re-applying migrations from $MODULE_DIR/migrations ..."
npx wrangler d1 migrations apply "$DB_NAME" --remote

# ── Step 4: verify empty ─────────────────────────────────────────────────────
echo "==> Verifying every table is empty ..."
TABLES="$(npx wrangler d1 execute "$DB_NAME" --remote --json \
  --command "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name <> 'd1_migrations';" \
  | jq -r '.[0].results[].name')"

FAIL=0
for t in $TABLES; do
  N="$(npx wrangler d1 execute "$DB_NAME" --remote --json \
        --command "SELECT COUNT(*) AS n FROM \"$t\";" | jq -r '.[0].results[0].n')"
  printf '    %-28s %s\n' "$t" "$N"
  [ "$N" = "0" ] || FAIL=1
done

if [ "$FAIL" -ne 0 ]; then
  echo "WARN: at least one table is non-empty. Investigate before declaring the reset done." >&2
  exit 1
fi

echo
echo "DONE. phronesis D1 ($DB_NAME / $UUID) exported to $DUMP and cleared."
echo "Glossolalia ($FORBIDDEN_UUID) was never referenced by this run."
