#!/usr/bin/env bash
# Restore a production backup into a NEW local database and point the dev
# .env files at it. Never touches the existing dev DB ("cafe-pos").
#
#   bash scripts/restore-prod-copy.sh [dump] [target_db]
#
# Mirrors production's DB posture: app connects as `postgres` (superuser) with
# RLS_ALLOW_SUPERUSER=true (deployment/2026-09-r2/cafe-config.draft.json, D15).
set -euo pipefail

DUMP="${1:-/c/Dev/POSDeployedDB/backup-25-09}"
DB="${2:-cafe_pos_prod_20260925}"
PGB="/c/Program Files/PostgreSQL/18/bin"
REPO="$(cd "$(dirname "$0")/.." && pwd)"

[ -f "$DUMP" ] || { echo "dump not found: $DUMP"; exit 1; }

read -r -s -p "postgres superuser password (localhost:5432): " PGPASSWORD; echo
export PGPASSWORD PGHOST=localhost PGPORT=5432 PGUSER=postgres

if [ -n "$("$PGB/psql" -w -d postgres -tAc "select 1 from pg_database where datname='$DB'")" ]; then
  echo "STOP: database $DB already exists. Drop it or pass another name."; exit 1
fi

echo "==> createdb $DB"
"$PGB/createdb" -w -O postgres "$DB"

echo "==> pg_restore (this takes a minute)"
"$PGB/pg_restore" -w -d "$DB" -j 4 --exit-on-error "$DUMP"

echo "==> sanity"
"$PGB/psql" -w -d "$DB" -tAc "
  select 'tables public: ' || count(*) from information_schema.tables where table_schema='public';
  select 'migrations applied: ' || count(*) from _prisma_migrations where finished_at is not null and rolled_back_at is null;
  select 'failed migrations: ' || count(*) from _prisma_migrations where finished_at is null and rolled_back_at is null;"

echo "==> repoint .env files (backups: *.bak-devdb)"
ENC=$(node -e 'process.stdout.write(encodeURIComponent(process.argv[1]))' "$PGPASSWORD")
URL="postgresql://postgres:${ENC}@localhost:5432/${DB}?schema=public"
for f in "$REPO/.env" "$REPO/apps/api/.env"; do
  [ -f "$f.bak-devdb" ] || cp "$f" "$f.bak-devdb"
  node -e '
    const fs=require("fs"); const [f,url]=process.argv.slice(1);
    let s=fs.readFileSync(f,"utf8");
    s=s.replace(/^DATABASE_URL=.*$/m, `DATABASE_URL="${url}"`);
    s=s.replace(/^RLS_ALLOW_SUPERUSER=.*$/m, "RLS_ALLOW_SUPERUSER=true");
    fs.writeFileSync(f,s);' "$f" "$URL"
  echo "   updated $f"
done

echo "==> prisma migrate status"
(cd "$REPO/apps/api" && DATABASE_URL="$URL" npx prisma migrate status) || true

echo "Done. Start: pnpm dev:api  /  pnpm dev:web"
echo "Revert to dev DB: mv .env.bak-devdb .env; mv apps/api/.env.bak-devdb apps/api/.env"
