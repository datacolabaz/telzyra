#!/usr/bin/env bash
# Telzyra — local real-provider test (macOS/Linux).
#
#   bash <(curl -fsSL https://raw.githubusercontent.com/datacolabaz/telzyra/feature/integrations/scripts/real-test/start.sh)
#
# Uses its own folder (~/telzyra-real-test), so your normal working copy is not touched.
# Starts: PostgreSQL (embedded, port 54329), API + workers (4000), web app (3000, or the next free port).
# Secrets: CREDENTIALS_KEY is generated locally; the Google client secret is read with a hidden
# prompt and written only to backend/.env (mode 600). Nothing secret is printed or committed.
# Stop everything with Ctrl+C.
set -euo pipefail

DIR="${TELZYRA_TEST_DIR:-$HOME/telzyra-real-test}"
BRANCH="${TELZYRA_BRANCH:-feature/integrations}"
REPO="https://github.com/datacolabaz/telzyra.git"
LOGS="$DIR/logs"

say() { printf "\n\033[1m▸ %s\033[0m\n" "$1"; }
die() { printf "\n\033[31m✗ %s\033[0m\n" "$1" >&2; exit 1; }

command -v git >/dev/null || die "git is required"
command -v node >/dev/null || die "Node.js 22+ is required (https://nodejs.org)"
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
[ "$NODE_MAJOR" -ge 22 ] || die "Node.js 22+ is required (found $(node -v))"
[ "$NODE_MAJOR" = 22 ] || [ "$NODE_MAJOR" = 24 ] || echo "  note: tested with Node 22/24, you have $(node -v) (usually fine)"
FREE_GB=$(df -Pk "$HOME" | awk 'NR==2 {printf "%d", $4/1048576}')
if [ "$FREE_GB" -lt 3 ]; then
  die "Only ${FREE_GB} GB free on disk; at least 3 GB is needed (dependencies + database). Free some space and run again.
  Biggest folders in your home:  du -sh ~/* ~/.[!.]* 2>/dev/null | sort -h | tail -15"
fi
in_use() { lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1; }
who_uses() { lsof -nP -iTCP:"$1" -sTCP:LISTEN 2>/dev/null | awk 'NR>1 {print "    " $1 " (pid " $2 ")"}' | sort -u; }
# API port is fixed: it is part of the Google redirect URI (http://localhost:4000/v1/oauth/google/callback).
for p in 4000 54329; do
  if in_use $p; then
    die "Port $p is used by:
$(who_uses $p)
  Stop that program (or: kill <pid>) and run again."
  fi
done
# Web app port: first free one.
WEB_PORT=""
for p in 3000 3001 3100 3200 3300; do in_use $p || { WEB_PORT=$p; break; }; done
[ -n "$WEB_PORT" ] || die "Ports 3000-3300 are all in use"
if [ "$WEB_PORT" != 3000 ]; then
  echo "  port 3000 is used by:"; who_uses 3000
  echo "  → the web app will run on port $WEB_PORT instead"
fi
APP_URL="http://localhost:$WEB_PORT"

say "Getting the code ($BRANCH) into $DIR"
if [ -d "$DIR/.git" ]; then
  git -C "$DIR" fetch -q origin "$BRANCH"
  git -C "$DIR" checkout -q "$BRANCH"
  git -C "$DIR" reset -q --hard "origin/$BRANCH"
else
  git clone -q -b "$BRANCH" "$REPO" "$DIR"
fi
mkdir -p "$LOGS"
cd "$DIR"
echo "  commit $(git rev-parse --short HEAD)"

say "Installing dependencies (first run takes a few minutes)"
(cd backend && npm ci --no-audit --no-fund --loglevel=error)
(cd frontend && npm ci --no-audit --no-fund --loglevel=error)

say "Configuring backend/.env"
ENV=backend/.env
umask 077
touch "$ENV"
# set_default KEY VALUE — only when KEY is missing or empty (existing values are kept)
set_default() {
  if ! grep -q "^$1=..*" "$ENV"; then
    grep -v "^$1=" "$ENV" > "$ENV.tmp" || true
    printf '%s=%s\n' "$1" "$2" >> "$ENV.tmp"
    mv "$ENV.tmp" "$ENV"
  fi
}
set_default NODE_ENV development
set_default DATABASE_URL postgresql://telzyra:telzyra@localhost:54329/telzyra_dev
if ! grep -q '^CREDENTIALS_KEY=[0-9a-f]\{64\}$' "$ENV"; then
  set_default CREDENTIALS_KEY "$(node -e "process.stdout.write(require('crypto').randomBytes(32).toString('hex'))")"
  echo "  new local encryption key generated"
fi
set_default CREDENTIALS_KEY_VERSION 1
# The web app port may differ between runs: always keep these in sync.
grep -v -e '^APP_URL=' -e '^CORS_ORIGINS=' "$ENV" > "$ENV.tmp" || true
printf 'APP_URL=%s\nCORS_ORIGINS=%s\n' "$APP_URL" "$APP_URL" >> "$ENV.tmp"
mv "$ENV.tmp" "$ENV"
set_default PUBLIC_API_URL http://localhost:4000
set_default TELEGRAM_TRIGGER_MODE polling
set_default LOG_LEVEL info
set_default TRUST_PROXY 0
grep -q '^COOKIE_DOMAIN=..*' "$ENV" && die "COOKIE_DOMAIN must be empty for localhost (edit backend/.env)"
chmod 600 "$ENV"
if ! grep -q '^GOOGLE_CLIENT_SECRET=..*' "$ENV"; then
  echo "  Google OAuth client (Google Cloud → Clients → your Web client)."
  read -r -p "  Client ID: " GID </dev/tty
  read -r -s -p "  Client secret (hidden): " GSECRET </dev/tty; echo
  [ -n "$GID" ] && [ -n "$GSECRET" ] || die "Client ID and secret are required for Google Sheets"
  grep -v '^GOOGLE_CLIENT_' "$ENV" > "$ENV.tmp" || true
  printf 'GOOGLE_CLIENT_ID=%s\nGOOGLE_CLIENT_SECRET=%s\n' "$GID" "$GSECRET" >> "$ENV.tmp"
  mv "$ENV.tmp" "$ENV"; chmod 600 "$ENV"
  unset GSECRET
  echo "  saved to backend/.env"
fi
# Same-origin API proxy: the browser talks only to the web app's port (some embedded browsers block
# cross-port requests to localhost); Next.js forwards /api/v1/* to the API on :4000.
printf 'NEXT_PUBLIC_SITE_URL=%s\nTELZYRA_API_URL=http://localhost:4000\nNEXT_PUBLIC_API_URL=%s/api\nTELZYRA_API_PROXY=1\n' "$APP_URL" "$APP_URL" > frontend/.env.local

PIDS=()
cleanup() {
  say "Stopping"
  for pid in "${PIDS[@]:-}"; do kill "$pid" 2>/dev/null || true; done
  wait 2>/dev/null || true
}
trap cleanup EXIT INT TERM

say "Starting PostgreSQL (port 54329)"
(cd backend && node scripts/local-db.mjs > "$LOGS/db.log" 2>&1) & PIDS+=($!)
for _ in $(seq 1 60); do grep -q "PostgreSQL running" "$LOGS/db.log" 2>/dev/null && break; sleep 1; done
grep -q "PostgreSQL running" "$LOGS/db.log" || die "PostgreSQL did not start (see $LOGS/db.log)"

say "Database migrations + schema drift check"
(cd backend && npx prisma migrate deploy)
(cd backend && npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --exit-code >/dev/null 2>&1 && echo "  ✓ schema matches migrations (no drift)") || die "Schema drift detected"

say "Pre-flight check"
(cd backend && npm run -s doctor) || die "Fix the problems above and run again"

say "Starting API + workers (port 4000) and web app (port $WEB_PORT)"
(cd backend && npm run -s dev > "$LOGS/api.log" 2>&1) & PIDS+=($!)
(cd frontend && npx next dev -p "$WEB_PORT" > "$LOGS/web.log" 2>&1) & PIDS+=($!)
for _ in $(seq 1 90); do
  curl -sf http://localhost:4000/health >/dev/null 2>&1 && curl -sf -o /dev/null "$APP_URL/login" 2>/dev/null && break
  sleep 1
done
curl -sf http://localhost:4000/health >/dev/null || die "API did not start (see $LOGS/api.log)"

printf "\n\033[32m✓ Telzyra is running: %s\033[0m\n" "$APP_URL"
echo "  Logs: $LOGS (api.log shows trigger polls and runs). Keep this window open; Ctrl+C stops everything."
tail -n 0 -F "$LOGS/api.log" | grep --line-buffered -E "workflow execution failed|trigger poll failed|retrying provider|ERROR|error" &
PIDS+=($!)
wait
