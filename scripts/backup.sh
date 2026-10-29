#!/usr/bin/env bash
# Nightly TredMail backup: a PostgreSQL dump, checked, encrypted and copied off the server.
#
#   ./scripts/backup.sh [compose project]          (deploy-hostinger.sh installs it in cron)
#
# Settings, read from the environment or the env file (.env):
#   BACKUP_DIR            where dumps are kept on the server (default /var/backups/tredmail)
#   BACKUP_KEEP_DAYS      days of local dumps to keep (default 14)
#   BACKUP_AGE_RECIPIENT  an age public key (age1...). Dumps and a copy of the env file are
#                         encrypted to it before they leave the server. Keep the matching
#                         private key OFF the server (password manager); restore.sh needs it.
#   BACKUP_RCLONE_REMOTE  rclone destination for the encrypted copies, e.g. b2:tredmail/prod.
#                         Configure it once with `rclone config`.
#   ALERT_WEBHOOK_URL     a failed backup is reported here (the same chat webhook as alerts)
#
# The env file matters as much as the database: TREDMAIL_MASTER_ENCRYPTION_KEY decrypts the
# stored DKIM keys and webhook secrets, so a database backup without it cannot be used.
set -euo pipefail

cd "$(dirname "$0")/.."
PROJECT="${1:-tredmail-production}"
ENV_FILE="${ENV_FILE:-.env}"
COMPOSE_FILE_PATH="${COMPOSE_FILE_PATH:-docker-compose.prod.yml}"
COMPOSE=(docker compose -f "$COMPOSE_FILE_PATH" --env-file "$ENV_FILE" -p "$PROJECT")

# A setting from the environment, else from the env file, else the default
setting() {
  local name="$1" default="${2:-}" value="${!1:-}"
  if [ -z "$value" ] && [ -f "$ENV_FILE" ]; then
    value=$(grep -E "^${name}=" "$ENV_FILE" | tail -n 1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//')
  fi
  echo "${value:-$default}"
}

BACKUP_DIR=$(setting BACKUP_DIR /var/backups/tredmail)
KEEP_DAYS=$(setting BACKUP_KEEP_DAYS 14)
AGE_RECIPIENT=$(setting BACKUP_AGE_RECIPIENT)
RCLONE_REMOTE=$(setting BACKUP_RCLONE_REMOTE)
ALERT_URL=$(setting ALERT_WEBHOOK_URL)
PG_USER=$(setting POSTGRES_USER tredmail)
PG_DB=$(setting POSTGRES_DB tredmail)

STAMP=$(date -u +%Y%m%dT%H%M%SZ)
DUMP="$BACKUP_DIR/tredmail-$STAMP.dump"

alert() {
  echo "backup: $1" >&2
  [ -n "$ALERT_URL" ] || return 0
  local text="*[TredMail alert · $(hostname)] Database backup failed*\n$1\n• See /var/log/tredmail-backup.log on the server."
  curl -fsS -m 10 -H "Content-Type: application/json" -d "{\"text\":\"$text\",\"content\":\"$text\"}" "$ALERT_URL" >/dev/null || true
}
trap 'alert "The backup stopped with an error at line $LINENO."' ERR

mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"
umask 077

# 1. Dump (custom format: compressed, restorable table by table)
"${COMPOSE[@]}" exec -T postgres pg_dump -U "$PG_USER" -d "$PG_DB" -Fc > "$DUMP.partial"
mv "$DUMP.partial" "$DUMP"

# 2. Check the dump is readable before trusting it
"${COMPOSE[@]}" exec -T postgres pg_restore --list < "$DUMP" > /dev/null
echo "backup: $DUMP ($(du -h "$DUMP" | cut -f1)) written and checked"

# 3. Encrypt for off-server storage: the dump, and the env file with the master key
UPLOADS=()
if [ -n "$AGE_RECIPIENT" ]; then
  age -r "$AGE_RECIPIENT" -o "$DUMP.age" "$DUMP"
  age -r "$AGE_RECIPIENT" -o "$BACKUP_DIR/env-$STAMP.age" "$ENV_FILE"
  UPLOADS=("$DUMP.age" "$BACKUP_DIR/env-$STAMP.age")
fi

# 4. Copy off the server. Unencrypted copies never leave it.
if [ -n "$RCLONE_REMOTE" ]; then
  if [ ${#UPLOADS[@]} -eq 0 ]; then
    alert "BACKUP_RCLONE_REMOTE is set but BACKUP_AGE_RECIPIENT is not, so nothing was copied off the server (copies are only uploaded encrypted)."
    exit 1
  fi
  for file in "${UPLOADS[@]}"; do rclone copy --no-traverse "$file" "$RCLONE_REMOTE"; done
  echo "backup: encrypted copies uploaded to $RCLONE_REMOTE"
else
  echo "backup: WARNING no BACKUP_RCLONE_REMOTE, so this backup exists only on this server" >&2
fi

# 5. Keep KEEP_DAYS days locally
find "$BACKUP_DIR" -maxdepth 1 \( -name 'tredmail-*.dump' -o -name 'tredmail-*.dump.age' -o -name 'env-*.age' \) -mtime +"$KEEP_DAYS" -delete

date -u +%Y-%m-%dT%H:%M:%SZ > "$BACKUP_DIR/last-success"
echo "backup: done"
