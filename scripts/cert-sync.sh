#!/usr/bin/env bash
# Copies the Let's Encrypt certificates Caddy manages for the mail hostnames into ./certs,
# where KumoMTA (STARTTLS on port 25) and the SMTP relay (587/465) read them.
#
#   ./scripts/cert-sync.sh [compose project]     (deploy-hostinger.sh installs it in cron)
#
# KumoMTA only reads its certificate at start, so it is restarted when that certificate
# changes (about every 60 days). The relay reloads its certificate by itself.
set -euo pipefail

cd "$(dirname "$0")/.."
PROJECT="${1:-tredmail-production}"
ENV_FILE="${ENV_FILE:-.env}"
COMPOSE=(docker compose -f docker-compose.prod.yml --env-file "$ENV_FILE" -p "$PROJECT")

# shellcheck disable=SC1090
source <(grep -E '^(MTA_HOSTNAME|SMTP_RELAY_HOSTNAME)=' "$ENV_FILE" || true)
MTA_HOSTNAME="${MTA_HOSTNAME:-mta1.tredmail.dovepeakdigital.com}"
SMTP_RELAY_HOSTNAME="${SMTP_RELAY_HOSTNAME:-smtp.tredmail.dovepeakdigital.com}"

mkdir -p certs
chmod 755 certs

# Copies <host>.crt/.key out of Caddy's storage as certs/<name>.crt/.key. Prints "changed".
sync_cert() {
  local host="$1" name="$2"
  local path
  path=$("${COMPOSE[@]}" exec -T caddy sh -c "find /data/caddy/certificates -name '$host.crt' | head -n 1" 2>/dev/null | tr -d '\r')
  if [ -z "$path" ]; then
    echo "cert-sync: Caddy has no certificate for $host yet (is its A record published?)" >&2
    return 0
  fi
  local tmp
  tmp=$(mktemp -d)
  "${COMPOSE[@]}" cp "caddy:$path" "$tmp/$name.crt" >/dev/null
  "${COMPOSE[@]}" cp "caddy:${path%.crt}.key" "$tmp/$name.key" >/dev/null
  if ! cmp -s "$tmp/$name.crt" "certs/$name.crt" 2>/dev/null; then
    # Readable by the kumod (999) and node (1000) users inside the containers only through
    # this host directory, which is not served anywhere.
    install -m 644 "$tmp/$name.crt" "certs/$name.crt"
    install -m 644 "$tmp/$name.key" "certs/$name.key"
    echo "changed"
  fi
  rm -rf "$tmp"
}

if [ "$(sync_cert "$MTA_HOSTNAME" mta)" = "changed" ]; then
  echo "cert-sync: new certificate for $MTA_HOSTNAME; restarting KumoMTA"
  "${COMPOSE[@]}" restart kumomta >/dev/null
fi
if [ "$(sync_cert "$SMTP_RELAY_HOSTNAME" smtp)" = "changed" ]; then
  echo "cert-sync: new certificate for $SMTP_RELAY_HOSTNAME (the relay reloads it within 10 minutes)"
fi
