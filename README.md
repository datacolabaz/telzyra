# Telzyra

An independent visual workflow automation platform. This is a monorepo with two
services, both deployed on Railway. See [ARCHITECTURE.md](./ARCHITECTURE.md) for the
full design and phased plan.

```
frontend/   Next.js 16 marketing site + (later) SaaS app   → Railway service "frontend"
backend/    Telzyra Platform API (Hono, Node 22)           → Railway service "backend"
```

## Run locally

Two terminals:

```bash
# 1) backend  → http://localhost:4000
cd backend
npm install
npm run dev

# 2) frontend → http://localhost:3000
cd frontend
npm install
cp .env.example .env.local      # points TELZYRA_API_URL at the local backend
npm run dev
```

The frontend also runs without the backend. Pricing then uses its built-in defaults,
and the account forms show "service not available yet".

## Backend

Express 5 + TypeScript + Prisma 7 (PostgreSQL). Tests: `npm test` (Vitest, real Postgres via `TEST_DATABASE_URL`).

| Method | Path | Notes |
|---|---|---|
| GET | `/health` | Checks the database; used by Railway's health check |
| GET | `/v1/plans` | Plan catalogue with per-currency prices |
| POST | `/v1/auth/register` | Creates user + workspace (OWNER) + session cookie |
| POST | `/v1/auth/login` | Session cookie; rate-limited per IP + email |
| POST | `/v1/auth/logout` | Requires session + `x-csrf-token` |
| GET | `/v1/auth/me` | Current user, workspace, role, CSRF token |

Security model:
- Passwords: Argon2id. Sessions: random 256-bit token in an `HttpOnly; SameSite=Lax` cookie; only its SHA-256 is stored.
- CSRF: `x-csrf-token` (HMAC of the session token) on state-changing requests + Origin allowlist.
- Credentials: AES-256-GCM with per-record IV, AAD bound to workspace + connection, versioned keys (`CREDENTIALS_KEY`, `CREDENTIALS_KEY_VERSION`, `CREDENTIALS_PREVIOUS_KEYS`).
- Tenant isolation: tenant data is accessed through `forWorkspace(prisma, workspaceId)`, which scopes every query.
- Logs redact tokens, cookies, passwords, OAuth codes and webhook signatures. Audit log records security events without secrets.

Migrations run on Railway before each deploy (`prisma migrate deploy`), followed by a drift check
(`prisma migrate diff --exit-code`) that stops the deploy if the database and `schema.prisma` disagree.

## Deploy on Railway

Two Railway services deploy from this GitHub repo (`datacolabaz/telzyra`, branch `main`).
Settings are configured on each service (Settings tab), not in a config file:

| Setting | backend | frontend |
|---|---|---|
| Root Directory | `/backend` | `/frontend` |
| Build command | `npm run build` | `npm run build` |
| Start command | `node dist/server.js` | `npm run start` |
| Healthcheck path | `/health` | `/` |
| Watch paths | `/backend/**` | `/frontend/**` |
| Restart policy | On failure, 5 retries | On failure, 5 retries |

Variables:

```
backend:   PORT=4000
           HOST=0.0.0.0
           CORS_ORIGINS=https://<frontend domain>,https://telzyra.com

frontend:  NEXT_PUBLIC_SITE_URL=https://<frontend domain>
           TELZYRA_API_URL=https://<backend domain>
```

Use full literal URLs. `${{service.VAR}}` references only resolve between services in the
**same** Railway project. If `NEXT_PUBLIC_SITE_URL` is empty or invalid, the site falls back to
`https://telzyra.com` for canonical URLs.

Each service rebuilds only when its own folder changes. Every push to `main` deploys automatically.

**Custom domain:** frontend → Networking → Custom Domain → `telzyra.com`, add the DNS record
Railway shows at your registrar, then set `NEXT_PUBLIC_SITE_URL=https://telzyra.com`.

## Languages
Switcher order **AZ, RU, TR, EN**. English is the default at `/`; `/az`, `/ru` and `/tr` are prefixed.

| Locale | URL | Default currency |
|---|---|---|
| English (default) | `/` | $ USD |
| Azerbaijani | `/az/` | ₼ AZN |
| Russian | `/ru/` | ₼ AZN |
| Turkish | `/tr/` | ₺ TRY |

- `/en/*` permanently redirects to the unprefixed URL. There is no IP or `Accept-Language` redirect.
- The chosen language is remembered in the `TELZYRA_LOCALE` cookie.
- Copy lives in `frontend/src/i18n/messages/<locale>/<namespace>.json`. Components never contain UI text.
- `npm run i18n:check` (also run before every build) fails on missing keys or mismatched placeholders.

## Currency
The pricing currency selector offers **₼ AZN | $ USD | ₺ TRY | ₽ RUB**. It defaults to the page
language's currency, and the visitor's choice is remembered in the `TELZYRA_CURRENCY` cookie.
Each plan has fixed per-currency price points (`backend/src/plans.ts`, mirrored as a fallback
in `frontend/src/config/plans.ts`). These are placeholders until billing is configured.
