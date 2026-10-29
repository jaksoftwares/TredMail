#!/usr/bin/env bash
# Restores a TredMail database dump made by scripts/backup.sh.
#
#   Drill (safe, recommended monthly): restore into a scratch database and check it
#     ./scripts/restore.sh /var/backups/tredmail/tredmail-20261101T013000Z.dump --into tredmail_restore_test
#
#   Disaster recovery: replace the live database (stops the API, worker and relay meanwhile)
#     ./scripts/restore.sh tredmail-20261101T013000Z.dump.age --yes
#
# Encrypted dumps (.age) need BACKUP_AGE_IDENTITY: the path to the age private key, kept off
# the server and copied over only for the restore. The env file must hold the same
# TREDMAIL_MASTER_ENCRYPTION_KEY as when the dump was made; the key check at the end proves it.
#
# Options: --into <database>  restore into this database instead of the live one
#          --yes              confirm replacing the live database
#          --project <name>   compose project (default tredmail-production)
set -euo pipefail

cd "$(dirname "$0")/.."
FILE=""
TARGET=""
CONFIRMED=false
PROJECT="tredmail-production"
while [ $# -gt 0 ]; do
  case "$1" in
    --into) TARGET="$2"; shift 2 ;;
    --yes) CONFIRMED=true; shift ;;
    --project) PROJECT="$2"; shift 2 ;;
    *) FILE="$1"; shift ;;
  esac
done
[ -n "$FILE" ] && [ -f "$FILE" ] || { echo "usage: $0 <dump file> [--into <database>] [--yes] [--project <name>]" >&2; exit 2; }

ENV_FILE="${ENV_FILE:-.env}"
COMPOSE_FILE_PATH="${COMPOSE_FILE_PATH:-docker-compose.prod.yml}"
COMPOSE=(docker compose -f "$COMPOSE_FILE_PATH" --env-file "$ENV_FILE" -p "$PROJECT")
setting() {
  local name="$1" default="${2:-}" value="${!1:-}"
  if [ -z "$value" ] && [ -f "$ENV_FILE" ]; then
    value=$(grep -E "^${name}=" "$ENV_FILE" | tail -n 1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//')
  fi
  echo "${value:-$default}"
}
PG_USER=$(setting POSTGRES_USER tredmail)
PG_DB=$(setting POSTGRES_DB tredmail)
PG_PASSWORD=$(setting POSTGRES_PASSWORD)
LIVE=false
if [ -z "$TARGET" ] || [ "$TARGET" = "$PG_DB" ]; then TARGET="$PG_DB"; LIVE=true; fi
if [[ ! "$TARGET" =~ ^[a-zA-Z_][a-zA-Z0-9_]*$ ]]; then echo "restore: invalid database name '$TARGET'" >&2; exit 2; fi
if $LIVE && ! $CONFIRMED; then
  echo "restore: this replaces the live database '$PG_DB'. Run again with --yes, or use --into <scratch database> for a drill." >&2
  exit 2
fi

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
DUMP="$FILE"
if [[ "$FILE" == *.age ]]; then
  IDENTITY=$(setting BACKUP_AGE_IDENTITY)
  [ -n "$IDENTITY" ] && [ -f "$IDENTITY" ] || { echo "restore: set BACKUP_AGE_IDENTITY to the age private key file to decrypt $FILE" >&2; exit 2; }
  DUMP="$WORK/restore.dump"
  age -d -i "$IDENTITY" -o "$DUMP" "$FILE"
fi

psql_admin() { "${COMPOSE[@]}" exec -T postgres psql -v ON_ERROR_STOP=1 -U "$PG_USER" -d postgres "$@"; }

if $LIVE; then
  echo "restore: stopping the API, worker and SMTP relay"
  "${COMPOSE[@]}" stop api worker smtp-relay 2>/dev/null || true
else
  # A drill starts from an empty scratch database
  psql_admin -c "DROP DATABASE IF EXISTS \"$TARGET\";" -c "CREATE DATABASE \"$TARGET\";" > /dev/null
fi

echo "restore: restoring $(basename "$FILE") into '$TARGET'"
"${COMPOSE[@]}" exec -T postgres pg_restore --clean --if-exists --no-owner -U "$PG_USER" -d "$TARGET" < "$DUMP"

COUNTS=$("${COMPOSE[@]}" exec -T postgres psql -At -U "$PG_USER" -d "$TARGET" -c \
  "SELECT (SELECT count(*) FROM organizations) || ' workspaces, ' || (SELECT count(*) FROM domains) || ' domains, ' || (SELECT count(*) FROM emails) || ' emails, ' || (SELECT count(*) FROM invoices) || ' invoices'")
echo "restore: restored $COUNTS"

# The restored secrets must decrypt with this installation's master key
echo "restore: checking that stored keys decrypt with TREDMAIL_MASTER_ENCRYPTION_KEY"
"${COMPOSE[@]}" run --rm --no-deps -e "DATABASE_URL=postgresql://$PG_USER:$PG_PASSWORD@postgres:5432/$TARGET?schema=public" \
  api node apps/api/dist/cli/check-keys.js

if $LIVE; then
  echo "restore: applying any newer migrations, then starting the services"
  "${COMPOSE[@]}" run --rm --no-deps api npx prisma migrate deploy --schema=packages/db/prisma/schema.prisma
  "${COMPOSE[@]}" up -d
else
  echo "restore: drill complete. Remove the scratch database with: docker compose ... exec postgres psql -U $PG_USER -d postgres -c 'DROP DATABASE \"$TARGET\";'"
fi
