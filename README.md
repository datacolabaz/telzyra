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

## Backend endpoints

| Method | Path | Status |
|---|---|---|
| GET | `/health` | live: health check used by Railway |
| GET | `/v1/plans` | live: plan catalogue with per-currency prices |
| POST | `/v1/auth/register`, `/v1/auth/login` | contract only: returns `503 {"code":"service.unavailable"}` until phase 2 (database + auth) |

## Deploy on Railway

One Railway project with two services from the same GitHub repo (`datacolabaz/telzyra`, branch `main`).

**1. Create the project:** Railway → New Project → Deploy from GitHub repo → `datacolabaz/telzyra`.

**2. Backend service** (Settings):
- Service name: `backend`
- Root Directory: `/backend`
- Config file path: `/backend/railway.json` (Railway does not look inside the root directory for this file on its own)
- Variables:
  ```
  PORT=4000
  CORS_ORIGINS=https://${{frontend.RAILWAY_PUBLIC_DOMAIN}},https://telzyra.com
  ```
- Networking → Generate Domain

**3. Frontend service:** add a second service from the same repo (+ New → GitHub Repo):
- Service name: `frontend`
- Root Directory: `/frontend`
- Config file path: `/frontend/railway.json`
- Variables:
  ```
  TELZYRA_API_URL=https://${{backend.RAILWAY_PUBLIC_DOMAIN}}
  NEXT_PUBLIC_SITE_URL=https://${{RAILWAY_PUBLIC_DOMAIN}}
  ```
- Networking → Generate Domain

**4. Custom domain (when ready):** frontend → Networking → Custom Domain → `telzyra.com`,
then add the DNS record Railway shows at your domain registrar. After that, set
`NEXT_PUBLIC_SITE_URL=https://telzyra.com` (canonical URLs and the sitemap use it),
and optionally give the backend `api.telzyra.com`.

Each service rebuilds only when its own folder changes (`watchPatterns` in `railway.json`).
Every push to `main` deploys automatically.

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
