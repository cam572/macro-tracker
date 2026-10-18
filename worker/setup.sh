#!/usr/bin/env bash
# One-time setup for the Macro Coach server. Run from this folder after `npx wrangler login`.
#   ./setup.sh deploy   → creates storage, generates keys, deploys, prints your server URL + key
#   ./setup.sh whoop    → asks for your Whoop Client ID/Secret (hidden) and saves them as secrets
set -euo pipefail
cd "$(dirname "$0")"

case "${1:-}" in
  deploy)
    if grep -q REPLACE_WITH_KV_ID wrangler.toml; then
      echo "Creating storage..."
      id=$(npx wrangler kv namespace create STORE 2>&1 | grep -Eo '[0-9a-f]{32}' | head -1)
      [ -n "$id" ] || { echo "Couldn't create the KV namespace — is wrangler logged in?"; exit 1; }
      sed -i '' "s/REPLACE_WITH_KV_ID/$id/" wrangler.toml
    fi
    echo "Deploying..."
    out=$(npx wrangler deploy 2>&1) || { echo "$out"; exit 1; }
    url=$(echo "$out" | grep -Eo 'https://[a-z0-9.-]+\.workers\.dev' | head -1)
    # Encryption key: generated and stored, never shown. App key: shown once so you can paste it in the app.
    openssl rand -base64 32 | npx wrangler secret put ENC_KEY >/dev/null
    appkey=$(openssl rand -hex 24)
    printf '%s' "$appkey" | npx wrangler secret put APP_KEY >/dev/null
    echo
    echo "✅ Server is live."
    echo "   Coach server URL:  $url"
    echo "   Server key:        $appkey"
    echo "   Whoop redirect URL (paste into the Whoop developer dashboard):  $url/whoop/callback"
    echo
    echo "Paste the URL and key into the tracker: Setup → Connections. Keep the key private."
    ;;
  whoop)
    read -r -p "Whoop Client ID: " cid
    read -r -s -p "Whoop Client Secret (hidden): " csec; echo
    printf '%s' "$cid"  | npx wrangler secret put WHOOP_CLIENT_ID >/dev/null
    printf '%s' "$csec" | npx wrangler secret put WHOOP_CLIENT_SECRET >/dev/null
    echo "✅ Whoop credentials saved. In the tracker: Setup → Connections → Whoop → Connect."
    ;;
  *) echo "Usage: ./setup.sh deploy | whoop"; exit 1 ;;
esac
