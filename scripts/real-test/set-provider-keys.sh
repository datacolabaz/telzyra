#!/usr/bin/env bash
# Asks (hidden input) for a provider's OAuth app credentials and writes them to backend/.env.
# Values are never echoed, logged or committed. The running API (tsx watch) reloads on its own.
#
#   bash scripts/real-test/set-provider-keys.sh slack
#   bash scripts/real-test/set-provider-keys.sh meta notion hubspot shopify
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
ENV="$ROOT/backend/.env"
[ -f "$ENV" ] || { echo "✗ $ENV not found — run scripts/real-test/start.sh first."; exit 1; }

keys_for() {
  case "$1" in
    slack)   echo "SLACK_CLIENT_ID SLACK_CLIENT_SECRET SLACK_SIGNING_SECRET" ;;
    meta)    echo "META_APP_ID META_APP_SECRET" ;;
    notion)  echo "NOTION_CLIENT_ID NOTION_CLIENT_SECRET" ;;
    hubspot) echo "HUBSPOT_APP_ID HUBSPOT_CLIENT_ID HUBSPOT_CLIENT_SECRET" ;;
    shopify) echo "SHOPIFY_CLIENT_ID SHOPIFY_CLIENT_SECRET" ;;
    *) return 1 ;;
  esac
}

[ $# -gt 0 ] || { echo "usage: $0 <slack|meta|notion|hubspot|shopify> ..."; exit 1; }

for p in "$@"; do
  keys="$(keys_for "$p")" || { echo "✗ unknown provider: $p"; exit 1; }
  echo "▸ $p (input is hidden; Enter on an empty value keeps the current one)"
  for k in $keys; do
    read -r -s -p "  $k: " v </dev/tty; echo
    v="${v#"${v%%[![:space:]]*}"}"; v="${v%"${v##*[![:space:]]}"}"   # trim whitespace from paste
    [ -n "$v" ] || { echo "    (kept)"; continue; }
    case "$v" in
      *[[:space:]]*) echo "    ✗ contains spaces — that is not a key (was a command pasted?). Not saved; run again."; continue ;;
    esac
    grep -v "^$k=" "$ENV" > "$ENV.tmp" || true
    printf '%s=%s\n' "$k" "$v" >> "$ENV.tmp"
    # Write in place (not mv): the API's file watcher only notices changes to the same file.
    cat "$ENV.tmp" > "$ENV"; rm -f "$ENV.tmp"; chmod 600 "$ENV"
    echo "    ✓ saved (${#v} chars)"
  done
done
# Nudge the dev server's watcher (tsx watch) so the new values are loaded right away.
touch "$ROOT/backend/src/server.ts" 2>/dev/null || true
echo "✓ backend/.env updated — the API restarts automatically."
