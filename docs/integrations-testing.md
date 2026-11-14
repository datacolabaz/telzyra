# Integrations — Testing

Run (backend): `npm test` — Vitest against a real Postgres (`TEST_DATABASE_URL`, default
`postgresql://telzyra:telzyra@localhost:54329/telzyra_test`; the global setup drops and recreates the
schema from the committed migrations). All provider HTTP is intercepted with **msw**;
unhandled requests fail the test, so no test touches a real provider.

Result on 2026-11-14: **7 files, 76 tests, all passing**; backend `tsc --noEmit` clean; frontend
`tsc`, ESLint, `i18n:check` (en/az/ru/tr complete) and `next build` pass.

## Coverage by category

| Category | Tests |
|---|---|
| Unit — HTTP runtime | backoff + jitter on 5xx, `Retry-After` (and its cap), no retry of non-idempotent POST unless idempotency key, no retry on 4xx, circuit breaker opens, timeouts, Retry-After parsing |
| Unit — security | SSRF address ranges, URL rules, DNS-rebind via resolver, redirect not followed; template prototype protection; Gmail header injection + RFC 2047 |
| Unit — webhook signatures | Slack, Stripe (tolerance), HubSpot v3, Shopify (webhook + OAuth HMAC), Notion, Telegram |
| Integration — catalog & access | auth required, CSRF required, role check, schemas exposed |
| Integration — token connections | provider validation before save, encryption at rest, no token in responses/audit, invalid token, cross-workspace isolation, revoked token → status REVOKED |
| Integration — OAuth | PKCE URL + exact redirect URI, full callback with token exchange, state replay, session mismatch, denied consent, unknown state, single refresh under concurrency, `invalid_grant` → EXPIRED |
| Integration — workflows | **Telegram → Google Sheets → Telegram end-to-end** through the HTTP webhook endpoint, queue and engine; duplicate delivery; wrong secret/unknown endpoint; failed step recorded and resume without repeating succeeded steps; manual test run with sample data; definition validation |
| Integration — webhooks | Slack challenge, signed Slack event routed by team id, unsigned rejected, Stripe endpoint creation + signature + DLQ (FAILED → DEAD) + replay → PROCESSED, Shopify compliance `shop/redact` |
| Integration — polling | Sheets new-row baseline, new rows → one run each, checkpoint saved, no duplicate runs |
| Existing | auth (register/login/logout/me), tenancy, crypto, redaction — unchanged and passing |
| Queue | pg-boss smoke test against Postgres (start, send, worker receives) — manual script, passed |

## What is **not** verified

- No test was run against real provider APIs: no provider apps or credentials exist yet. Every
  provider status is therefore "implemented, mock-tested", not "live".
- UI was type-checked, linted and built, but not exercised in a browser against a running API.
- Load/perf tests were not run.

## Live verification checklist (per provider, after setup in `provider-setup-guide.md`)

1. Connect from `/dashboard/integrations`; check status Active and the account name.
2. "Test" on the connection → OK.
3. Builder → each action → "Test step" with real input; compare the result in the provider UI.
4. Activate a workflow with each trigger; produce a real event; check the run in "Runs".
5. Revoke access at the provider → next call marks the connection "Needs reconnect"/"Disconnected";
   "Reconnect" restores it.
6. Disconnect → provider webhook/endpoint removed (Telegram `getWebhookInfo`, Stripe dashboard, Shopify).
