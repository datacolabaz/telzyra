# Integrations — Security Review

Scope: everything added on `feature/integrations` (OAuth, credentials, connectors, webhooks, workflow
engine, UI). Reviewed against the requirements: secrets only from env, no token logging, CSRF,
webhook signatures, tenant isolation, audit logging.

## Controls

| Threat | Control | Evidence |
|---|---|---|
| Credential theft from DB dump | AES-256-GCM, key from `CREDENTIALS_KEY` (env), AAD binds ciphertext to workspace + connection (a row copied to another tenant fails to decrypt), key versions for rotation | `security/crypto.ts`, `credential.service.ts`; test: secret column never contains token |
| Secrets in API responses | `publicConnection()` whitelist; credentials never leave `ConnectorRuntime` | test: list/audit JSON contains no token |
| Secrets in logs | pino redaction of auth headers/cookies; request URL logged without query string (OAuth `code`/`state`) and with webhook endpoint token masked; HTTP metrics store host only (Telegram token is in the path); audit metadata keys matching secret patterns are redacted | `app.ts safeLogUrl`, `http.ts metric`, `audit.service.ts` |
| CSRF on API | Session cookie `SameSite=Lax` + HMAC CSRF token header on every state-changing route + Origin allowlist | test: POST without header → 403 |
| OAuth login-CSRF / code injection | Random state (stored hashed), single use (atomic claim), 10 min TTL, bound to session **and** workspace, PKCE S256 (Google), exact redirect URI, redirect target restricted to app-relative paths | tests: replay, other session, unknown state |
| Account swap on reconnect | Reauthorization must return the same provider account | `oauth.account_mismatch` |
| Missing scopes | Granted scopes compared to required when the provider reports them | `oauth.scopes_missing` |
| Shopify OAuth tampering | Shop domain regex + callback HMAC verified | `providers.ts` |
| Forged webhooks | Per provider: Slack v0 HMAC (5 min window), Stripe `t/v1` (5 min), HubSpot v3 (5 min, full URL), Shopify HMAC, Notion `sha256=`, Telegram secret token (per subscription, encrypted). Constant-time comparison. Unknown endpoint → 404, bad signature → 401, nothing stored | `test/unit/webhook-signatures.test.ts`, integration tests |
| Webhook replay / duplicates | Timestamp windows + unique `(provider, dedupeKey)` + unique `(workflowId, triggerEventId)` | test: duplicate Telegram update |
| Tenant isolation | Prisma `forWorkspace()` extension on tenant models; runtime loads connections through it; workflow validation rejects other workspaces' connections; webhook events listed/replayed only within workspace | tests: 404 for foreign connection, workflow validation |
| Privilege | OWNER/ADMIN required to connect, test, reauthorize, disconnect, delete connections and replay events | test: MEMBER → 403 |
| SSRF (HTTP Request step) | Scheme/port allowlist, no URL credentials, every resolved IP must be public, redirects not followed, hop-by-hop headers stripped | unit tests incl. metadata IP redirect. **Bug found and fixed:** IPv4 ranges with the high bit set (172.16/12, 192.168/16, 169.254/16) were not blocked because of a signed bitwise result. |
| Template injection | Templates are path lookups only (no eval); prototype keys blocked; inputs are zod-validated **after** resolution (e.g. Gmail headers reject CR/LF) | unit tests |
| Abuse of webhook endpoint | Rate limit per provider + IP, 1 MB raw body limit | `webhooksRouter` |
| Unbounded storage | Step outputs > 64 KB stored truncated; event list returns metadata only | `templates.ts truncateForStorage` |
| Audit trail | connection.created/tested/refreshed/revoked/deleted, webhook.subscription.created, webhook.event.replayed, workflow.created/activated | `audit.service.ts` |

## Residual risks / follow-ups

1. **DNS rebinding (HTTP step):** the address is checked before `fetch`, which resolves again. A
   pinned-IP agent (undici `connect.lookup`) would close the window. Medium.
2. **Run history contains personal data** (trigger payloads, step outputs). Add a retention job
   (e.g. delete executions older than 30/90 days per plan) and mention it in the privacy policy. Medium.
3. **Webhook payloads** are stored unencrypted in `webhook_events.payload` (needed for replay). Same
   retention job should purge processed events after N days. Medium.
4. **Workspace members** (not only admins) may build workflows that use workspace connections. This is
   intended (connections are workspace resources) but should be stated in docs/UI. Low.
5. **Circuit breaker/metrics are per process.** Fine for one replica. Low.
6. **App-level webhooks for an account connected in several workspaces** start workflows in each of
   them (by design, each workspace authorized that account); the event row is not attributed to a
   single workspace, so it is not listed in the UI. Low.
7. **Gmail restricted scope** requires Google CASA before public launch. Compliance, not code.
8. `npm audit` was not part of this change; run it in CI.
