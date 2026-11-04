# Telzyra

An independent visual workflow automation platform. This repository holds the web
front end: the marketing site and, in later phases, the SaaS application. See
[ARCHITECTURE.md](./ARCHITECTURE.md) for the full design and phased plan.

## Stack
Next.js 16 (App Router, Cache Components) · React 19 · TypeScript · Tailwind CSS 4 ·
Inter (self-hosted) · lucide icons. The i18n layer has no external dependencies.

## Getting started
```bash
npm install
npm run dev            # http://localhost:3000
npm run build          # runs i18n:check first, then a production build
npm run i18n:check     # translation parity check
```

Environment variables (all optional in phase 1):

| Variable | Purpose |
|---|---|
| `NEXT_PUBLIC_SITE_URL` | Canonical origin used for metadata and the sitemap (default `https://telzyra.com`) |
| `TELZYRA_API_URL` | Telzyra Platform API. Unset → auth forms report "service unavailable" and plans use the defaults in `src/config/plans.ts` |

## Languages
| Locale | URL | Status |
|---|---|---|
| English (default) | `/` | active |
| Azerbaijani | `/az/` | active |
| Turkish | `/tr/` | active |
| Russian | `/ru/` | planned (404 until activated) |

- `/en/*` permanently redirects to the unprefixed URL.
- There are no IP-based or `Accept-Language` redirects.
- The language switcher stores the user's choice in the `TELZYRA_LOCALE` cookie, and
  unprefixed URLs honour it.
- Copy lives in `src/i18n/messages/<locale>/<namespace>.json`. Components never
  contain UI text.
- Node IDs (`trigger.webhook`, …) and error codes (`auth.invalid_credentials`, …) are
  technical identifiers. They are never translated, only mapped to labels.

**Adding a language:** add an entry to `src/i18n/config.ts`, add
`src/i18n/messages/<code>/`, run `npm run i18n:check`, then set `status: "active"`.

## Project layout
```
src/app/[locale]/(marketing)   landing, features, integrations, pricing
src/app/[locale]/(auth)        login, register
src/app/sitemap.ts, robots.ts  localized sitemap with hreflang alternates
src/components/                brand, ui primitives, marketing sections, i18n, auth
src/config/                    plans, integrations registry, use cases, site/nav
src/engine/nodes.ts            node catalogue (technical IDs)
src/i18n/                      locale registry, loader, translator, SEO helpers
src/proxy.ts                   locale resolution
```
