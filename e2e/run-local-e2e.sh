#!/usr/bin/env bash
# Browser E2E against a full local stack: Postgres (must be running), backend (real API + pg-boss,
# fake providers), frontend (production build). Usage: ./run-local-e2e.sh [playwright args]
set -euo pipefail
cd "$(dirname "$0")"
ROOT=$(cd .. && pwd)
export E2E_DATABASE_URL=${E2E_DATABASE_URL:-postgresql://telzyra:telzyra@localhost:54329/telzyra_e2e}
LOGS=${E2E_LOG_DIR:-/tmp/telzyra-e2e}; mkdir -p "$LOGS"

node reset-db.mjs

# Backend: throwaway key generated per run (never a real secret)
( cd "$ROOT/backend" && env NODE_ENV=test PORT=4000 HOST=127.0.0.1 DATABASE_URL="$E2E_DATABASE_URL" \
    CREDENTIALS_KEY="$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")" \
    APP_URL=http://localhost:3000 CORS_ORIGINS=http://localhost:3000 PUBLIC_API_URL=http://localhost:4000 TRUST_PROXY=0 \
    GOOGLE_CLIENT_ID=e2e-google-client.apps.googleusercontent.com GOOGLE_CLIENT_SECRET=e2e-google-secret LOG_LEVEL=info \
    npx tsx test/e2e/server.ts > "$LOGS/backend.log" 2>&1 ) &
BACK=$!

if [ "${E2E_SKIP_BUILD:-0}" != "1" ]; then
  ( cd "$ROOT/frontend" && NEXT_PUBLIC_SITE_URL=http://localhost:3000 TELZYRA_API_URL=http://localhost:4000 NEXT_PUBLIC_API_URL=http://localhost:4000 npx next build > "$LOGS/frontend-build.log" 2>&1 )
fi
( cd "$ROOT/frontend" && TELZYRA_API_URL=http://localhost:4000 npx next start -p 3000 > "$LOGS/frontend.log" 2>&1 ) &
FRONT=$!
trap 'kill $BACK $FRONT 2>/dev/null || true; pkill -f "test/e2e/server.ts" 2>/dev/null || true; pkill -f "next start -p 3000" 2>/dev/null; pkill -f next-server 2>/dev/null || true' EXIT

for i in $(seq 1 60); do
  curl -sf localhost:4000/health >/dev/null && curl -sf -o /dev/null localhost:3000/login && break
  sleep 1
done
npx playwright test "$@"
