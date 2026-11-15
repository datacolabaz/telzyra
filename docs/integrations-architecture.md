# Integrations — Architecture

Telzyra runs integrations in its own engine (Express API + Postgres). There is no external
automation service: triggers, steps, retries and run history all live in the Telzyra backend.

```
Browser (Next.js app)                         Providers (Telegram, Google, Slack, …)
   │  cookie session + CSRF header                 ▲ API calls            │ webhooks
   ▼                                               │                      ▼
/v1 API ─ integrationsRouter ─┬─ OAuthService ── CredentialService ── AES-256-GCM (credentials table)
                              ├─ ConnectionService
                              ├─ WorkflowService ── WorkflowEngine ── ConnectorRuntime ── HttpClient
                              └─ WebhookService ◄── /webhooks/:provider[/:endpointToken] (raw body)
                                       │
                         pg-boss queues (Postgres, schema "pgboss")
                         webhook.process · workflow.execute · trigger.poll(.tick) · maintenance.daily
                         + dead-letter queues webhook.process.dead · workflow.execute.dead
```

## Building blocks (backend/src)

| Area | Files | Responsibility |
|---|---|---|
| Connector SDK | `integrations/core/types.ts`, `registry.ts` | `ConnectorDefinition`: auth spec, actions (zod input), triggers (webhook/polling), webhook spec, error mapping, test(). Registry exposes metadata + JSON schemas to the UI. |
| HTTP runtime | `core/http.ts`, `circuit-breaker.ts`, `errors.ts` | Timeouts, retries with full-jitter backoff, `Retry-After`, 5xx/network retry only for idempotent or idempotency-keyed requests, per-connection circuit breaker, normalized `ConnectorError` codes, host-only metrics. |
| SSRF guard | `core/ssrf.ts` | User-supplied URLs (HTTP Request step): http/https, ports 80/443, all resolved IPs must be public, no credentials, no redirects. |
| Connector runtime | `core/runtime.ts` | Loads the connection *through the workspace-scoped client*, decrypts/refreshes credentials, validates input, runs the action, retries once after a forced refresh on `AUTH_EXPIRED`, updates connection status on auth errors. |
| OAuth | `oauth/providers.ts`, `oauth.service.ts` | Google, Slack, Notion, HubSpot, Shopify adapters. Authorization-code flow, PKCE (Google), single-use state bound to session + workspace (10 min TTL), scope check, account-mismatch check on reconnect, revoke. |
| Credentials | `connections/credential.service.ts` | Encrypt/decrypt with AAD `credential:<workspace>:<connection>`, key rotation, refresh under `SELECT … FOR UPDATE` so concurrent workers refresh once. |
| Connections | `connections/connection.service.ts` | Token/API-key connections (validated with the provider before saving), health test, disconnect (unsubscribe + revoke + delete secrets + pause workflows), delete. |
| Providers | `integrations/providers/*.ts` | Telegram, Google Sheets, Slack, Notion, Gmail, HubSpot, Stripe, Shopify, HTTP Request. |
| Webhooks | `webhooks/webhook.service.ts` | Ingest (resolve subscription, verify, dedupe, persist, enqueue) and async processing (resolve tenant(s), convert to trigger events, dispatch). DLQ + replay. Shopify compliance topics. |
| Workflow engine | `workflows/*.ts` | Definition validation, template resolution, executions with per-step records, resumable runs, polling with checkpoints. |
| Queue | `queue/queue.ts` | pg-boss in production; `InlineQueue` for tests. |
| Wiring | `container.ts`, `app.ts`, `server.ts` | One service graph per process. `RUN_WORKERS=false` makes an instance API-only. |

## Data model (Prisma)

`Connection` (per workspace, unique `[workspaceId, provider, externalAccountId]`), `Credential`
(encrypted blob + expiry), `OAuthState`, `WebhookSubscription` (endpoint token, encrypted signing
secret, provider subscription id), `WebhookEvent` (unique `[provider, dedupeKey]`, status
RECEIVED → PROCESSING → PROCESSED | FAILED → DEAD), `Workflow` (JSON definition + denormalized
trigger columns), `WorkflowExecution` (unique `[workflowId, triggerEventId]`, step records),
`TriggerState` (polling cursor), `AuditLog`.

## Workflow definition (v1)

```json
{
  "trigger": { "connector": "telegram", "trigger": "new_message", "connectionId": "<uuid>", "config": {} },
  "steps": [
    { "id": "save", "connector": "google-sheets", "action": "append_row", "connectionId": "<uuid>",
      "input": { "spreadsheet_id": "…", "sheet": "Leads", "values": ["{{trigger.from.username}}", "{{trigger.text}}"] } },
    { "id": "reply", "connector": "telegram", "action": "send_message", "connectionId": "<uuid>",
      "input": { "chat_id": "{{trigger.chat.id}}", "text": "Saved to {{steps.save.updated_range}}" } }
  ]
}
```

- Steps run in order. Templates are pure path lookups (`trigger.*`, `steps.<id>.*`, `now`,
  `execution.id`); `__proto__`/`constructor` are blocked. A value that is exactly one template keeps
  its type.
- Manual workflows use `{ "connector": "manual", "trigger": "manual" }`.

## Execution semantics

- **Exactly-once start per event:** `WorkflowExecution(workflowId, triggerEventId)` is unique, so
  webhook re-deliveries, duplicate polls and replays never start a second run for the same event.
- **No repeated side effects on retry:** each step result is saved immediately; a retried job skips
  succeeded steps. Write actions that support it (Stripe) send `Idempotency-Key = tz-<execution>-<step>`.
- **Failure:** the failing step is recorded with its normalized error code; remaining steps are
  `skipped`; the run is `FAILED`. Queue retries (2, exponential) apply to infrastructure failures;
  exhausted jobs go to the dead-letter queue and the run is marked failed.

## Trigger modes

| Mode | Providers | How |
|---|---|---|
| Per-connection webhook | Telegram, Stripe, Shopify | On activation Telzyra registers `https://<api>/webhooks/<provider>/<endpointToken>` at the provider (one subscription per connection, shared by its workflows). Secrets are stored encrypted. |
| App-level webhook | Slack, Notion, HubSpot | One URL per Telzyra app (configured in the provider's developer console). Events are routed by account id (Slack team, Notion workspace, HubSpot portal) to every active connection of that account. |
| Polling | Google Sheets (new/updated row), Gmail (new email), Notion (updated pages) | `trigger.poll.tick` runs every minute and enqueues due workflows (`POLL_INTERVAL_MINUTES`, default 5) with a singleton key; the cursor is saved only after events were dispatched; the first poll sets a baseline. |

## Rate limits and resilience

- Provider 429s are retried honoring `Retry-After` (capped by `maxDelayMs`, 30 s) — always, even for POST,
  because a 429 means the request was not processed.
- Circuit breaker per `<provider>:<connection>`: 5 consecutive provider failures open it for 30 s.
- Inbound webhooks: 1 200 requests/min per provider and IP, 1 MB body limit.
- Breakers and metrics are per process (in memory). With several API replicas each has its own breaker.

## Inbound Webhook trigger (generic)

Connector `webhook`, trigger `catch_hook`. On activation each workflow gets its own URL
`{PUBLIC_WEBHOOK_URL}/webhooks/hook/<token>` (192-bit token; `workflow_hooks` stores its SHA-256 for lookup and an
encrypted copy to show it to the owner). `POST`/`PUT` with JSON, form or text (≤ 1 MB) starts an execution with
`{ method, body, query, headers, received_at }` — authorization, cookie and proxy/CDN headers are dropped.
`Idempotency-Key` or `X-Request-Id` → at most one execution per key. Paused or unknown → 404. `POST
/v1/workflows/:id/webhook/rotate` replaces the URL. Logs show `/webhooks/hook/[token]`. Code: `backend/src/workflows/hooks.ts`.
