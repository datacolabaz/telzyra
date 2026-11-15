# Integrations — Implementation Plan

Branch: `feature/integrations` (from `main` @ `1c7b5de`, clean working tree).
`main` auto-deploys to production on Railway, so this branch is **not merged** without approval.

## 1. Audit of the existing system (verified in code)

| # | Area | Finding | Reuse |
|---|---|---|---|
| 1 | Frontend | Next.js 16 App Router, React 19, TS, Tailwind 4. Routes under `src/app/[locale]/` with groups `(marketing)`, `(auth)`, `(app)`. Custom i18n (`src/i18n`, EN default, AZ/RU/TR active), parity check `npm run i18n:check`. | Yes: `(app)` shell, `getTranslations`, design primitives |
| 2 | Backend | Express 5 + TS (`backend/src`), JSON API under `/v1`, error model `AppError{status, code}` with localizable codes. | Yes |
| 3 | DB / ORM | PostgreSQL + Prisma 7 (`prisma-client` generator, `@prisma/adapter-pg`). One migration `20261112200000_init`. Railway runs `migrate deploy` + drift check pre-deploy. | Yes; new migration is additive |
| 4 | Auth | Session cookie `tz_session` (hashed token), CSRF header `x-csrf-token` (HMAC of session), Origin allowlist, roles OWNER/ADMIN/MEMBER, `requireAuth`, `requireRole`. | Yes |
| 5 | Tenancy | `forWorkspace(prisma, id)` Prisma extension scopes Membership, Connection, WebhookSubscription. | Yes; extend to new tenant models |
| 6 | Encryption | `CredentialCipher` AES-256-GCM, tenant-bound AAD, key versions, `CREDENTIALS_KEY` from env (stable, verified by fingerprint). | Yes |
| 7 | Workflow engine | **None.** Only a static node catalogue in `frontend/src/engine/nodes.ts` (marketing). | Build minimal engine |
| 8 | Queue / jobs | **None.** | Add pg-boss (Postgres-backed; no new infra) |
| 9 | Webhooks | Tables `webhook_subscriptions`, `webhook_events` exist (dedupe unique key, status, attempts); no receiver. | Reuse tables |
| 10 | Deployment | Railway: backend + Postgres (project `vivacious-hope`), frontend (project `generous-beauty`). Domains telzyra.com, api.telzyra.com. | — |
| 11 | Integrations | None implemented. Marketing registry `frontend/src/config/integrations.ts` lists all as `planned`. Tables `connections`, `credentials`, `oauth_states` exist. | Reuse tables |
| 12 | Git | `main` clean; no other branches with work. | — |

**Sandbox constraint:** Prisma engine binaries cannot be downloaded here (`binaries.prisma.sh` blocked by policy). Migrations are written by hand and verified by applying them to a local Postgres; the Railway pre-deploy drift check (`prisma migrate diff --exit-code`) is the authoritative verification and blocks a deploy on any mismatch.

## 2. Architecture decisions

- **Provider adapters.** `OAuthProvider` (authorize URL, token exchange, refresh, revoke, identity) is separate from `ConnectorDefinition` (actions, triggers, schemas, webhooks). Adding a provider = one folder + registry entry.
- **Credentials** are only decrypted inside the backend runtime (`CredentialService.getValid()`), refreshed under a Postgres row lock (`SELECT … FOR UPDATE`) so concurrent workers never double-refresh.
- **HTTP client** for all providers: timeouts, retries with exponential backoff + jitter, `Retry-After`, 5xx retry, per-connection circuit breaker, metrics hooks, secret-free logs. SSRF guard for user-configurable URLs.
- **Workflow engine (v1):** linear workflow = 1 trigger + N action steps; inputs support `{{trigger.…}}` / `{{steps.<id>.…}}` templates (safe path lookup, no `eval`). Executions stored with per-step status, input, output and errors.
- **Queue:** pg-boss queues `webhook.process`, `workflow.execute`, `trigger.poll`, with retry/backoff and dead-letter queues. Workers run in the API process (`RUN_WORKERS=true`), separable later.
- **Webhooks:** `/webhooks/:provider[/:endpointToken]` with raw body → provider verifier → dedupe (`UNIQUE(provider, dedupeKey)`) → store → enqueue → fast 2xx.
- **Polling triggers** (Google Sheets, Gmail, Notion fallback): scheduled job with persisted checkpoints, labelled "polling" in the UI.

## 3. Missing functionality → modules

1. OAuth service + connections API (start, callback, reauthorize, revoke, test, health).
2. Connector SDK/runtime + registry/discovery.
3. Webhook subsystem + DLQ.
4. Providers: Telegram, Google Sheets, Slack, Notion; then Gmail, HubSpot, Stripe, Shopify.
5. Workflow engine: models, API, executor, trigger dispatch, polling.
6. UI: Integrations marketplace, My connections, Workflows (builder + runs).
7. Sample workflow Telegram → Google Sheets → Telegram (automated test with mocked providers).

## 4. Risks

| Risk | Mitigation |
|---|---|
| No provider credentials available in this environment | Everything mock-tested; real smoke tests listed as user actions |
| Google restricted scopes (Gmail read) need CASA | Gmail read actions behind a separate connection scope set; documented |
| Shopify protected customer data / HubSpot & Slack & Notion app-level webhooks | Account-id routing + documentation |
| Hand-written migrations | Applied locally + pre-deploy drift check |
| Workers inside API process | Single replica today; queue is Postgres-backed so a worker service can be split out |

## 5. Testing strategy

Vitest against real Postgres; provider APIs mocked with MSW. Categories: unit (crypto, templates, retry, breaker, signatures, SSRF), API integration (OAuth start/callback, connections, workflows), token refresh concurrency, tenant isolation, webhook signature/dedupe/DLQ, connector actions per provider, workflow execution incl. the sample workflow, frontend build + browser flow.

## 6. Deployment considerations

Additive migration only; new env vars per provider (all optional — a provider without credentials is shown as "not configured"); `PUBLIC_API_URL` for OAuth redirect URIs and webhook URLs. Production deploy and merge to `main` require explicit approval (see `docs/integrations-deployment.md`).

## 7. Status (2026-11-14)

Implemented on `feature/integrations`: modules 2–7, security review, tests, docs. See
`integrations-architecture.md`, `provider-setup-guide.md`, `integrations-security.md`,
`integrations-testing.md`, `integrations-deployment.md`.

| Provider | Code | Tests | Live |
|---|---|---|---|
| Telegram | done | mocked, incl. end-to-end workflow | ✅ real Bot API (polling mode) on 2026-11-15; webhook mode pending |
| Google Sheets | done | mocked (OAuth, refresh, actions, polling) | ✅ real OAuth + append/read on 2026-11-15 (test project) |
| Slack | done | mocked (signature, challenge, routing) | ✅ real on 2026-11-15 (test app, local + tunnel): OAuth v2, Events URL verified, list_channels, send_channel_message, not_in_channel error, Slack message → workflow → thread reply (no loop). Note: connect in a normal browser — the Claude desktop pane blocks the tunnel → localhost callback |
| Continue with Google (sign-in) | done | mocked Google token/userinfo; real state, linking, sessions (12 tests) | pending real Google test (needs redirect URI added in Google Cloud) |
| Notion | done | mocked (signature) | ✅ real on 2026-11-15 (OAuth connection "Telzyra Local Test", user capability: none): OAuth, connection test, search, create_page, get_page_content. Webhook triggers not yet real-tested |
| Gmail | done, **send-only by default** (`GMAIL_READ_ENABLED=false`, no CASA) | mocked (MIME, header injection, metadata headers, scope flag) | ✅ real on 2026-11-15 (test project, Testing mode): send ✅, search ✅, read ✅, new_email poll → Slack ✅ (bug found: metadata headers; fixed). Public launch still needs Google verification + CASA for the read scope |
| HubSpot | done | mocked (signature v3) | needs HubSpot app |
| Stripe | done | mocked (endpoint, signature, DLQ/replay) | needs restricted test key |
| Shopify | done | mocked (HMAC, compliance) | needs Shopify app + protected data access |
| HTTP Request | done | mocked (SSRF, redirects) | ✅ real on 2026-11-15: POST to httpbin.org from a webhook-triggered workflow, response used in the next step |
| Webhook (inbound trigger) | done (2026-11-15): per-workflow secret URL `/webhooks/hook/<token>`, rotate, idempotency key | 8 integration tests | ✅ real on 2026-11-15: internet → Cloudflare tunnel → gateway → workflow → HTTP Request → Slack |
| Facebook Pages | done | mocked (appsecret_proof, page tokens, errors) | ✅ real on 2026-11-15 (Meta app in development mode, admin user): OAuth (Facebook Login for Business), list_pages (8 Pages), create_post + delete_post on a real Page. Public use needs Meta App Review (+ Business Verification) |
| Instagram | done | mocked (containers, status polling, quota, carousel/reel) | ✅ real on 2026-11-15: list_accounts (5 IG business accounts), get_publishing_limit, publish_image → real post (permalink returned; quota used 0→1). Image hosts must allow Meta's fetcher (Wikimedia refused → clear VALIDATION error). Carousel/Reels not yet real-tested. Public use needs App Review |
