#!/usr/bin/env bash
# ==============================================================================
# TredMail Automated Production Deployment Script for Hostinger KVM VPS
# A Product of Dovepeak Technology
# ==============================================================================

set -e

echo "🚀 Starting TredMail Production Deployment on Hostinger KVM..."

# 1. Update OS packages
echo "📦 Updating Ubuntu package repositories..."
sudo apt-get update -y && sudo apt-get upgrade -y
sudo apt-get install -y curl git ufw jq dnsutils

# 2. Install Docker & Docker Compose if not present
if ! command -v docker &> /dev/null; then
    echo "🐳 Installing Docker Engine..."
    curl -fsSL https://get.docker.com -o get-docker.sh
    sudo sh get-docker.sh
    sudo usermod -aG docker $USER
    rm get-docker.sh
fi

if ! docker compose version &> /dev/null; then
    echo "🐳 Installing Docker Compose Plugin..."
    sudo apt-get install -y docker-compose-plugin
fi

# 3. Deliverability Diagnostic: Check Reverse DNS (PTR)
SERVER_IP=$(curl -s -4 https://ifconfig.me || hostname -I | awk '{print $1}')
echo "🔍 Checking Reverse DNS for IP: $SERVER_IP..."
PTR_RECORD=$(dig -x $SERVER_IP +short || true)

if [ -z "$PTR_RECORD" ]; then
    echo "⚠️ WARNING: No PTR (Reverse DNS) record detected for $SERVER_IP."
    echo "   Action needed: Go to Hostinger hPanel -> VPS -> Settings -> IP address -> Set PTR to mail.tredmail.dovepeak.com"
else
    echo "✅ Reverse DNS detected: $PTR_RECORD"
fi

# 4. Deliverability Diagnostic: Check Outbound Port 25
echo "🔍 Checking Outbound Port 25 Connectivity..."
if timeout 5 bash -c '</dev/tcp/gmail-smtp-in.l.google.com/25' 2>/dev/null; then
    echo "✅ Port 25 Outbound is OPEN and reachable."
else
    echo "⚠️ NOTICE: Outbound Port 25 connection timed out."
    echo "   If blocked, contact Hostinger support to unblock port 25 for your business transactional emails."
fi

# 5. Verify .env file exists
if [ ! -f ".env" ]; then
    echo "📝 Generating production .env file from template..."
    cp .env.example .env
    # Generate every secret; nothing from the template is reused
    sed -i "s/^NODE_ENV=.*/NODE_ENV=production/" .env
    sed -i "s/^TREDMAIL_MASTER_ENCRYPTION_KEY=.*/TREDMAIL_MASTER_ENCRYPTION_KEY=$(openssl rand -hex 32)/" .env
    sed -i "s/^INTERNAL_API_TOKEN=.*/INTERNAL_API_TOKEN=$(openssl rand -hex 32)/" .env
    echo "POSTGRES_PASSWORD=$(openssl rand -hex 24)" >> .env
    chmod 600 .env
    echo "🔑 Generated master encryption key, internal API token and database password."
    echo "   Back up .env securely: losing the master key makes stored DKIM keys unrecoverable."
fi

# 6. Launch Production Containers
echo "🚢 Launching TredMail Production Cluster..."
docker compose -f docker-compose.prod.yml up -d --build

# 7. Apply database migrations (never `db push` in production)
echo "🗄️ Applying database migrations..."
docker compose -f docker-compose.prod.yml exec -T api npx prisma migrate deploy --schema=prisma/schema.prisma

# 8. Seed Initial Organization & Master API Key (prints the key once)
echo "🌱 Initializing Dovepeak Organization..."
docker compose -f docker-compose.prod.yml exec -T api node dist/db/seed.js

echo ""
echo "=============================================================================="
echo "🎉 TREDMAIL IS LIVE IN PRODUCTION!"
echo "   Management Console: https://console.tredmail.dovepeak.com"
echo "   API Gateway:        https://api.tredmail.dovepeak.com/v1"
echo "   Tracking Proxy:     https://track.tredmail.dovepeak.com"
echo "=============================================================================="
