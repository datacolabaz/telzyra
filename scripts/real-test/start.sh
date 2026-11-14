#!/usr/bin/env bash
# Telzyra — local real-provider test (macOS/Linux).
#
#   bash <(curl -fsSL https://raw.githubusercontent.com/datacolabaz/telzyra/feature/integrations/scripts/real-test/start.sh)
#
# Uses its own folder (~/telzyra-real-test), so your normal working copy is not touched.
# Starts: PostgreSQL (embedded, port 54329), API + workers (4000), web app (3000).
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
[ "$(node -p 'process.versions.node.split(".")[0]')" -ge 22 ] || die "Node.js 22+ is required (found $(node -v))"
for p in 3000 4000 54329; do
  if lsof -nP -iTCP:$p -sTCP:LISTEN >/dev/null 2>&1; then
    die "Port $p is in use. Stop the program using it (lsof -nP -iTCP:$p -sTCP:LISTEN) and run again."
  fi
done

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
if [ ! -f "$ENV" ]; then
  umask 077
  KEY=$(node -e "process.stdout.write(require('crypto').randomBytes(32).toString('hex'))")
  cat > "$ENV" <<EOF
NODE_ENV=development
DATABASE_URL=postgresql://telzyra:telzyra@localhost:54329/telzyra_dev
CREDENTIALS_KEY=$KEY
CREDENTIALS_KEY_VERSION=1
APP_URL=http://localhost:3000
CORS_ORIGINS=http://localhost:3000
COOKIE_DOMAIN=
PUBLIC_API_URL=http://localhost:4000
TELEGRAM_TRIGGER_MODE=polling
LOG_LEVEL=info
TRUST_PROXY=0
EOF
  unset KEY
  echo "  created (new local encryption key generated)"
fi
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
cp -n frontend/.env.example frontend/.env.local 2>/dev/null || true

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

say "Starting API + workers (port 4000) and web app (port 3000)"
(cd backend && npm run -s dev > "$LOGS/api.log" 2>&1) & PIDS+=($!)
(cd frontend && npm run -s dev > "$LOGS/web.log" 2>&1) & PIDS+=($!)
for _ in $(seq 1 90); do
  curl -sf http://localhost:4000/health >/dev/null 2>&1 && curl -sf -o /dev/null http://localhost:3000/login 2>/dev/null && break
  sleep 1
done
curl -sf http://localhost:4000/health >/dev/null || die "API did not start (see $LOGS/api.log)"

printf "\n\033[32m✓ Telzyra is running: http://localhost:3000\033[0m\n"
echo "  Logs: $LOGS (api.log shows trigger polls and runs). Keep this window open; Ctrl+C stops everything."
tail -n 0 -F "$LOGS/api.log" | grep --line-buffered -E "workflow execution failed|trigger poll failed|retrying provider|ERROR|error" &
PIDS+=($!)
wait
