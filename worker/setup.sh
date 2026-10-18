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
    # Key goes to a private file, not the terminal, so it never lands in logs or chat
    umask 077; printf 'Coach server URL: %s\nServer key: %s\n' "$url" "$appkey" > SERVER_KEY.txt
    echo
    echo "✅ Server is live."
    echo "   Coach server URL:  $url"
    echo "   Whoop redirect URL (paste into the Whoop developer dashboard):  $url/whoop/callback"
    echo "   Server key saved to: $(pwd)/SERVER_KEY.txt  (paste it into the tracker: Setup → Connections)"
    ;;
  whoop)
    read -r -p "Whoop Client ID: " cid
    read -r -s -p "Whoop Client Secret (hidden — paste ONCE, then Enter): " csec; echo
    csec=$(printf '%s' "$csec" | tr -d '[:space:]')
    # Hidden input shows nothing, so a secret often gets pasted 2-6 times. Collapse exact repeats.
    n=${#csec}
    for k in 2 3 4 5 6 7 8; do
      if [ $((n % k)) -eq 0 ]; then
        part=${csec:0:$((n / k))}; rep=""; for ((i=0; i<k; i++)); do rep+="$part"; done
        if [ "$rep" = "$csec" ]; then echo "  (looks like it was pasted $k times — using one copy)"; csec=$part; break; fi
      fi
    done
    echo "  Got a ${#csec}-character secret."
    printf '%s' "$cid"  | npx wrangler secret put WHOOP_CLIENT_ID >/dev/null
    printf '%s' "$csec" | npx wrangler secret put WHOOP_CLIENT_SECRET >/dev/null
    echo "✅ Whoop credentials saved. In the tracker: Setup → Connections → Whoop → Connect."
    ;;
  *) echo "Usage: ./setup.sh deploy | whoop"; exit 1 ;;
esac
