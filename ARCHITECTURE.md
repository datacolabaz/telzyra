# Telzyra — Architecture & Implementation Plan

Telzyra is an independent workflow-automation SaaS with its own execution engine.
This document covers the six items required before implementation: architecture,
component structure, routes, localization, marketing ↔ app communication, and the
phased plan.

> **Language policy:** English is the primary and default language, served at `/`.
> Azerbaijani (`/az/`), Russian (`/ru/`) and Turkish (`/tr/`) are live. The switcher
> shows **AZ | RU | TR | EN**.
>
> **Currency policy:** pricing shows a currency selector (**₼ AZN | $ USD | ₺ TRY | ₽ RUB**).
> The default follows the page language (AZ → ₼, RU → ₼, TR → ₺, EN → $), and the
> visitor's choice is remembered in the `TELZYRA_CURRENCY` cookie. Each plan has fixed
> per-currency price points (`config/plans.ts`), never live conversions.

---

## 1. System architecture

```
                ┌──────────────────────────────────────────────┐
                │            telzyra.com (Next.js 16)           │
                │                                              │
 Browser ──────▶│  proxy.ts  (locale resolution, auth gate)    │
                │     │                                        │
                │     ├── (marketing)  static, SEO, cacheable   │
                │     ├── (auth)       login / register / reset │
                │     └── (app)        /dashboard/** (private)  │
                │                │                             │
                │        src/lib/api  (typed BFF client)        │
                └────────────────┼─────────────────────────────┘
                                 │ HTTPS + session token
                ┌────────────────▼─────────────────────────────┐
                │          Telzyra Platform API (separate)      │
                │  auth · workspaces · billing · plans/limits   │
                │  workflows CRUD · credentials vault · i18n    │
                │  user prefs (locale) · email dispatch         │
                └────────────────┬─────────────────────────────┘
                                 │ queue
                ┌────────────────▼─────────────────────────────┐
                │          Telzyra Workflow Engine (separate)   │
                │  node runtime · triggers · scheduler ·        │
                │  webhooks · execution log · retries           │
                └──────────────────────────────────────────────┘
```

- **One Next.js app, two surfaces.** The marketing site and the SaaS app share one
  design system and one i18n layer. They are split by **route groups** with their own
  layouts, so the marketing pages stay static and indexable while the app stays
  dynamic, authenticated and `noindex`.
- **The engine is a separate service.** The web app never runs workflows. It talks
  to the Platform API, which queues work for the Engine. That lets the engine scale
  on its own and keeps the web tier stateless.
- **No fake functionality.** Until an API endpoint exists, the matching UI says the
  service is unavailable. It never pretends to succeed.

## 2. Component structure

Repository layout: `frontend/` (this Next.js app) and `backend/` (Platform API), deployed as two Railway services. Paths below are inside `frontend/`.

```
src/
├── app/
│   ├── [locale]/                     # root layout (html lang, fonts, providers)
│   │   ├── (marketing)/              # Header + Footer layout
│   │   │   ├── page.tsx              # landing
│   │   │   ├── pricing/  features/  integrations/
│   │   │   └── legal/privacy  legal/terms         (phase 2)
│   │   ├── (auth)/                   # minimal centered layout
│   │   │   ├── login/  register/  reset-password/  verify-email/
│   │   │   └── onboarding/                        (phase 2)
│   │   └── (app)/dashboard/          # sidebar layout (phase 3)
│   │       ├── workflows/  integrations/  executions/  billing/  settings/
│   ├── sitemap.ts  robots.ts
├── components/
│   ├── brand/        Logo, LogoMark
│   ├── ui/           Button, Container, Section, Badge, Card (stateless primitives)
│   ├── marketing/    Header, Footer, Hero, ProblemSection, FeatureGrid, HowItWorks,
│   │                 IntegrationsSection, UseCases, PricingSection, PricingToggle,
│   │                 Faq, FinalCta, WorkflowPreview
│   ├── i18n/         LanguageSwitcher
│   └── app/          Sidebar, StatCard, WorkflowTable … (phase 3)
├── config/
│   ├── plans.ts         plan definitions, the fallback for API-provided limits
│   ├── integrations.ts  connector registry with an honest status field
│   └── site.ts          site URL, nav structure (keys, not text)
├── engine/
│   └── nodes.ts         node catalogue: technical IDs (never translated)
├── i18n/
│   ├── config.ts        locale registry (status, labels, hreflang, OG locale)
│   ├── messages/<locale>/<namespace>.json
│   ├── server.ts        getTranslations(), getLocale(), formatters
│   ├── routing.ts       localized href builder, alternates for SEO
│   └── seo.ts           buildMetadata() → canonical + hreflang + OG
├── lib/api/             typed Platform API client (phase 2)
└── proxy.ts             locale + auth proxy
```

Rules:
- Components contain **no user-facing text**. Every string comes from a message file,
  either through `getTranslations()` in Server Components or as props passed to
  Client Components.
- Client components stay small and few: the language switcher, the billing toggle,
  the mobile nav, forms. Everything else is a Server Component, so message files
  never ship to the browser.

## 3. Routes

| Public path (EN) | AZ | TR | Surface | Indexed |
|---|---|---|---|---|
| `/` | `/az` | `/tr` | Landing | ✅ |
| `/features` | `/az/features` | `/tr/features` | Marketing | ✅ |
| `/integrations` | `/az/integrations` | `/tr/integrations` | Marketing | ✅ |
| `/pricing` | `/az/pricing` | `/tr/pricing` | Marketing | ✅ |
| `/login`, `/register`, `/reset-password`, `/verify-email` | `/az/…` | `/tr/…` | Auth | ❌ noindex |
| `/onboarding` | `/az/onboarding` | `/tr/onboarding` | Auth | ❌ |
| `/dashboard/**` | `/az/dashboard/**` | `/tr/dashboard/**` | App | ❌ |

- `/en/*` permanently redirects (308) to the unprefixed URL, so English has exactly
  one canonical address.
- `/ru/*` returns 404 until Russian is set to `active` in `i18n/config.ts`.
- Path segments stay in English in every language (`/az/pricing`). That keeps the
  routing logic language-independent. Localized slugs can be added later through a
  `pathnames` map in `routing.ts` without touching any page.

## 4. Localization architecture

**Locale registry** (`src/i18n/config.ts`) is the single source of truth:

```ts
en: { status: 'active',  nativeName: 'English',     hreflang: 'en', ogLocale: 'en_US' }
az: { status: 'active',  nativeName: 'Azərbaycanca', hreflang: 'az', ogLocale: 'az_AZ' }
tr: { status: 'active',  nativeName: 'Türkçe',       hreflang: 'tr', ogLocale: 'tr_TR' }
ru: { status: 'active',  nativeName: 'Русский',      hreflang: 'ru', ogLocale: 'ru_RU' }
```

Adding a language means adding one registry entry and one `messages/<locale>/`
folder. No component changes.

**Resolution (proxy.ts) — explicit, never IP-based:**
1. If the URL has an active locale prefix, use it.
2. If the URL starts with `/en`, redirect to the unprefixed path.
3. If the URL is unprefixed and the `TELZYRA_LOCALE` cookie holds an active
   non-English locale (meaning the user *chose* it earlier), redirect to that prefix.
4. Otherwise serve English. No IP lookup, and no `Accept-Language` redirect.

**Remembering the choice:** the language switcher writes the `TELZYRA_LOCALE` cookie
(1 year). Once a user is signed in, the choice is also saved to the user profile
through the Platform API, so it follows them across devices, and transactional
emails go out in that language.

**Message files** are split by namespace so each surface loads only what it needs:

| Namespace | Contents |
|---|---|
| `common` | nav, footer, CTAs, language names, generic labels |
| `seo` | per-page titles and descriptions |
| `home`, `pricing`, `features`, `integrations` | marketing copy |
| `auth` | login, register, reset, verification, onboarding |
| `validation` | form and API validation errors (keyed by error code) |
| `nodes` | node labels and descriptions, keyed by **technical node ID** |
| `app`, `billing`, `notifications`, `emails` | phases 2–3 |

**Technical identifiers are never translated.** Node IDs such as `trigger.webhook`
and `logic.condition` live in `src/engine/nodes.ts` and are stored as-is in
workflow JSON. Message files only *map* an ID to a display label, so a workflow
built in Azerbaijani opens correctly in Turkish. API error codes such as
`auth.invalid_credentials` follow the same pattern.

**Fallback and quality control:** a missing key falls back to English at runtime.
`npm run i18n:check` fails the build if an *active* locale is missing a key, has an
extra key, or uses placeholders that don't match English. Planned locales (Russian)
only produce a warning.

**SEO:** `buildMetadata()` sets a per-locale `<title>` and description, a canonical
URL, `hreflang` alternates for every active locale plus `x-default` → English, and
the OG locale. `sitemap.ts` lists every public page with its language alternates.

**Formatting:** prices, numbers and dates go through `Intl` with the active locale
(`az-AZ`, `tr-TR`, `en-US`). Currency stays USD.

## 5. Marketing site ↔ SaaS app communication

- **Same origin, shared session.** Both surfaces live on `telzyra.com`. The Platform
  API sets an `HttpOnly`, `Secure`, `SameSite=Lax` session cookie. `proxy.ts` makes an
  optimistic check on it to send logged-out users from `/dashboard` to `/login`, and
  the dashboard layout verifies the session server-side.
- **Header state:** the marketing header can show "Go to dashboard" instead of
  "Log in" by reading the session cookie's presence. It never needs user data.
- **Plans and limits:** pricing pages read plans from `GET /v1/plans` (cached and
  revalidated). `src/config/plans.ts` is the typed fallback and the contract. The
  same source drives the billing page, so the numbers can't drift apart.
- **Integration status:** the integrations page reads `GET /v1/connectors`. Only
  connectors marked `available` are presented as working.
- **Locale:** the user profile `locale` field ↔ the `TELZYRA_LOCALE` cookie. The app
  uses the same message files and the same `getTranslations()` helper.
- **Signup handoff:** marketing CTAs link to `/register?plan=<id>` in the current
  locale. After email verification, the user goes to `/onboarding` → workspace
  creation → `/dashboard`.

## 6. Implementation plan

| Phase | Scope | Status |
|---|---|---|
| **1. Foundation + marketing** | Next.js/TS setup, design tokens, logo, i18n layer (EN/AZ/TR, RU prepared), proxy, landing page with all sections, pricing, features, integrations pages, SEO (canonical, hreflang, sitemap, robots), i18n check script | ✅ this delivery |
| **2. Auth + onboarding** | Platform API client, register/login/reset/verify forms with localized validation, onboarding + workspace creation, localized email templates, legal pages | next |
| **3. App shell + dashboard** | Sidebar layout, workflow list, active workflows, recent executions, usage, connections, subscription, settings (incl. language preference) | |
| **4. Workflow editor** | Canvas, node palette from the node catalogue, inspector, validation, run and test against the engine | |
| **5. Billing + notifications** | Payment provider integration, plan enforcement from API limits, in-app notifications | |
| **6. Russian launch** | RU translation written and active; native review pending | ✅ |

### Open decisions (defaults used in phase 1)
- **Yearly pricing:** shown as 10× the monthly price ("2 months free") through a single
  `yearlyMonths` setting in `config/plans.ts`. Change it there.
- **Plan limits** (operations, active workflows, minimum interval, history) are
  **placeholder defaults** in `config/plans.ts` until the Platform API provides them.
- **Integrations:** no connector is live yet, so the site lists them as *planned*.
- **Translations:** AZ and TR copy is written natively, not machine-translated, but a
  professional native reviewer should sign it off before launch.
