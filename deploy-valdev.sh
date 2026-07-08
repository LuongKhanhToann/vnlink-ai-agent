#!/usr/bin/env bash
#
# Deploy vnlink-ai-agent (mastra) to the val DEV box as an ISOLATED, hidden service.
# Replaces the old Railway deploy. Runs alongside valgourmet's web-backend/web-landing
# without touching them (own dir, own pm2 name, own nginx vhost, external Supabase DB).
#
#   Usage:  ./deploy-valdev.sh            # auto-resolve IP from dev.valgourmet.vn
#           DEV_HOST=1.2.3.4 ./deploy-valdev.sh   # force IP (use after IP churn)
#
# One-time infra (already done; re-run only if rebuilt): nginx vhost + certbot cert
# for vinalink.13-215-95-186.sslip.io, and /var/www/vinalink_public for QR assets.
#
# NON-OBVIOUS QUIRKS this script handles (learned the hard way):
#   1. Build is on macOS -> the bundled libsql only has the darwin native binding.
#      The linux binding must be installed on-box every deploy (rsync --delete wipes it).
#   2. This mastra build produces NO instrumentation.mjs -> do NOT pass --import=...instrumentation.
#   3. `import "dotenv/config"` gets tree-shaken from the bundle -> the server .env is
#      loaded via node --env-file (Railway used to inject env directly, hiding this).
#   4. nginx (www-data) cannot read under /home/ubuntu (0750) -> QR assets are served
#      from world-readable /var/www/vinalink_public, refreshed here.
#
# The server .env (~/vinalink-ai-agent/.env) is the source of truth and is NOT overwritten.
set -euo pipefail

DEV_HOST="${DEV_HOST:-$(dig +short @1.1.1.1 dev.valgourmet.vn | tail -1)}"
[ -n "$DEV_HOST" ] || { echo "Could not resolve dev IP; pass DEV_HOST=..."; exit 1; }
KEY="${KEY:-/Users/khanhtoan/val/val_dev.pem}"
LIBSQL_VER="${LIBSQL_VER:-0.5.29}"
REMOTE_DIR="vinalink-ai-agent"
ROOT="$(cd "$(dirname "$0")" && pwd)"
SSH="ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -i $KEY"
DEST="ubuntu@$DEV_HOST"
say(){ printf "\n\033[1;36m==> %s\033[0m\n" "$*"; }

say "Deploy vnlink-ai-agent -> val dev ($DEV_HOST)"
chmod 600 "$KEY" 2>/dev/null || true

say "Build locally (mastra build)"
( cd "$ROOT"; npm run build )

say "Ship self-contained .mastra/output + package.json (server .env left untouched)"
$SSH "$DEST" "mkdir -p $REMOTE_DIR/.mastra/output"
rsync -az --delete -e "$SSH" "$ROOT/.mastra/output/" "$DEST:$REMOTE_DIR/.mastra/output/"
rsync -az          -e "$SSH" "$ROOT/package.json"    "$DEST:$REMOTE_DIR/"

say "On-box: install linux libsql binding, refresh QR assets, restart pm2"
$SSH "$DEST" "bash -lc '
  export NVM_DIR=\$HOME/.nvm; [ -s \$NVM_DIR/nvm.sh ] && . \$NVM_DIR/nvm.sh
  cd \$HOME/$REMOTE_DIR/.mastra/output
  npm install --no-save @libsql/linux-x64-gnu@$LIBSQL_VER >/dev/null 2>&1
  sudo mkdir -p /var/www/vinalink_public/qr
  sudo cp \$HOME/$REMOTE_DIR/.mastra/output/qr/*.png /var/www/vinalink_public/qr/ 2>/dev/null || true
  sudo chmod -R a+rX /var/www/vinalink_public
  cd \$HOME/$REMOTE_DIR
  pm2 delete vinalink-ai 2>/dev/null || true
  pm2 start .mastra/output/index.mjs --name vinalink-ai --time \
    --cwd \$HOME/$REMOTE_DIR --node-args=\"--env-file=\$HOME/$REMOTE_DIR/.env\"
  pm2 save
'"

say "Health check"
BASE="https://vinalink.13-215-95-186.sslip.io"
sleep 6
curl -s -o /dev/null -w "  $BASE/ (hidden) -> %{http_code}\n" --resolve "vinalink.13-215-95-186.sslip.io:443:$DEV_HOST" "$BASE/" || true
curl -s -o /dev/null -w "  $BASE/public/qr/fitness-qr.png -> %{http_code}\n" --resolve "vinalink.13-215-95-186.sslip.io:443:$DEV_HOST" "$BASE/public/qr/fitness-qr.png" || true
say "Done. (If the dev IP churned, the sslip host + TLS cert are stale — see DEPLOY note.)"
