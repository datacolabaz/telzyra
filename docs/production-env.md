# Production environment variables

Values are never stored in Git, logs or docs. Set them in Railway (service → Variables). Secret values are
marked 🔒: generate or paste them directly in Railway and never send them in chat or e-mail.

## Backend service (`api.telzyra.com`)

| Variable | Status | Value / how to obtain | Notes |
|---|---|---|---|
| `NODE_ENV` | set | `production` | Secure cookies, no stack traces |
| `HOST` | set | `0.0.0.0` (or `::`) | |
| `PORT` | set | `4000` | Must match the Railway domain target port |
| `DATABASE_URL` 🔒 | set | `${{Postgres.DATABASE_URL}}` (reference) | |
| `CREDENTIALS_KEY` 🔒 | set | 64 hex chars, generated in Railway | **Never change** without rotation (fingerprint `e7a166e95e4f`); changing it makes stored credentials unreadable |
| `CREDENTIALS_KEY_VERSION` | set (default 1) | integer | Bump only during key rotation |
| `CREDENTIALS_PREVIOUS_KEYS` 🔒 | not needed | `1:<hex>,…` | Only during rotation |
| `APP_URL` | set | `https://telzyra.com` | OAuth results redirect here |
| `CORS_ORIGINS` | set | `https://telzyra.com,https://www.telzyra.com` (whatever is served) | Must contain every origin the app is served from |
| `COOKIE_DOMAIN` | set | `.telzyra.com` | Shared session for `telzyra.com` and `api.telzyra.com` |
| `TRUST_PROXY` | default | `1` | Railway edge |
| `LOG_LEVEL` | optional | `info` | |
| `SESSION_TTL_DAYS` | optional | `30` | |
| **`PUBLIC_API_URL`** | **NEW — required** | `https://api.telzyra.com` | Builds OAuth redirect URIs and webhook URLs. Default is localhost, so OAuth and Telegram webhooks break without it |
| `RUN_WORKERS` | NEW, optional | `true` | `false` makes the instance API-only |
| `TELEGRAM_TRIGGER_MODE` | NEW, optional | `auto` | `auto` → webhook in production (public https) |
| `POLL_INTERVAL_MINUTES` | NEW, optional | `5` | Sheets/Gmail/Notion polling |
| `EXECUTION_RETENTION_DAYS` | NEW, optional | `30` | Finished workflow runs are deleted after N days (0 = keep) |
| `WEBHOOK_EVENT_RETENTION_DAYS` | NEW, optional | `30` | Settled webhook payloads are deleted after N days (0 = keep) |
| `GOOGLE_CLIENT_ID` | NEW, for Google | from Google Cloud → Credentials | Not secret, but keep in Railway |
| `GMAIL_READ_ENABLED` | optional, default `false` | leave unset | `true` requests the restricted `gmail.readonly` scope — only after Google verification + CASA |
| `GOOGLE_CLIENT_SECRET` 🔒 | NEW, for Google | from Google Cloud → Credentials | Redirect URIs: `https://api.telzyra.com/v1/oauth/google/callback` (Sheets/Gmail) and `https://api.telzyra.com/v1/auth/google/callback` (Continue with Google) |
| `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET` 🔒, `SLACK_SIGNING_SECRET` 🔒 | later | Slack app | |
| `NOTION_CLIENT_ID`, `NOTION_CLIENT_SECRET` 🔒, `NOTION_WEBHOOK_VERIFICATION_TOKEN` 🔒 | later | Notion integration | |
| `HUBSPOT_CLIENT_ID`, `HUBSPOT_CLIENT_SECRET` 🔒, `HUBSPOT_APP_ID` | later | HubSpot app | |
| `SHOPIFY_CLIENT_ID`, `SHOPIFY_CLIENT_SECRET` 🔒, `SHOPIFY_API_VERSION` | later | Shopify app | |
| `META_APP_ID`, `META_APP_SECRET` 🔒, `META_GRAPH_VERSION` | later | Meta app (Facebook Pages, Instagram) | Redirect `https://api.telzyra.com/v1/oauth/meta/callback` |
| `PUBLIC_WEBHOOK_URL` | optional | Leave unset in production (defaults to `PUBLIC_API_URL`) | Only for local tunnels |

Telegram and Stripe need no server variables (bot token / API key are entered per connection in the UI and
stored encrypted).

## Frontend service (`telzyra.com`)

| Variable | Value | Notes |
|---|---|---|
| `NEXT_PUBLIC_SITE_URL` | `https://telzyra.com` | Build-time |
| `TELZYRA_API_URL` | `https://api.telzyra.com` (or the private Railway URL) | Server-side session lookup |
| `NEXT_PUBLIC_API_URL` | `https://api.telzyra.com` | Build-time; browser calls (CSRF + cookie) |

No new frontend variables are introduced by the integrations work.

## Verify before release

Run on the backend service (Railway shell) or locally with the production values loaded from Railway:
`npm run doctor` — prints only names and derived URLs, checks DB/migrations, Google config, and that
`api.telegram.org`, `oauth2.googleapis.com` and `sheets.googleapis.com` are reachable.
