# Integrations — Deployment

Branch: `feature/integrations` (pushed, **not merged, not deployed**). Production deploys from
`main` on Railway; merging is the deploy trigger and needs the owner's approval.

## What changes in production

| Change | Type | Notes |
|---|---|---|
| Migration `20261114180000_workflows` | Additive only | New enums/tables (`workflows`, `workflow_executions`, `trigger_states`), new nullable columns (`oauth_states.connectionId`, `webhook_events.accountId`), indexes. No drops, no data rewrite. Runs in the existing pre-deploy command (`prisma migrate deploy` + drift check). |
| pg-boss schema `pgboss` | Created at boot | Created by pg-boss on first start in the same database. Prisma's drift check only compares the `public` schema. |
| New routes | `/v1/integrations`, `/v1/connections…`, `/v1/oauth/…`, `/v1/workflows…`, `/v1/executions/:id`, `/v1/webhook-events…`, `/webhooks/…` | |
| Background workers | In the API process | `RUN_WORKERS` (default `true`). A separate worker service can later run the same image with `RUN_WORKERS=true` and the API with `false`. |
| Frontend | New pages `/dashboard/integrations`, `/dashboard/workflows`, app nav | No new env vars. |

## Environment variables (backend)

Required for the new code: **`PUBLIC_API_URL=https://api.telzyra.com`** (OAuth redirect URIs and
webhook URLs are built from it; default is localhost). Optional:

| Variable | When |
|---|---|
| `RUN_WORKERS` | `false` to disable workers on an instance |
| `POLL_INTERVAL_MINUTES` | Polling frequency (default 5) |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Google Sheets, Gmail |
| `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`, `SLACK_SIGNING_SECRET` | Slack |
| `NOTION_CLIENT_ID`, `NOTION_CLIENT_SECRET`, `NOTION_WEBHOOK_VERIFICATION_TOKEN` | Notion |
| `HUBSPOT_CLIENT_ID`, `HUBSPOT_CLIENT_SECRET`, `HUBSPOT_APP_ID` | HubSpot |
| `SHOPIFY_CLIENT_ID`, `SHOPIFY_CLIENT_SECRET`, `SHOPIFY_API_VERSION` | Shopify |

Telegram and Stripe need no server variables. `CREDENTIALS_KEY` must **not** change (fingerprint
`e7a166e95e4f`), otherwise stored credentials become unreadable.

## Release checklist (owner approval required)

1. Review the PR `feature/integrations → main`.
2. Set `PUBLIC_API_URL=https://api.telzyra.com` on the backend service (production config change).
3. Merge → Railway builds; pre-deploy applies the additive migration; check deploy logs for
   `queue workers started` and `/health` = ok.
4. Smoke test: log in → Integrations page lists 9 apps (OAuth apps show "Not configured" until their
   variables are set) → connect a Telegram test bot → manual-trigger workflow with a Telegram step.
5. Create provider apps one by one (setup guide), set variables, redeploy, run the live checklist in
   `integrations-testing.md`. Mark a provider live only after that.
6. Keep the marketing page (`frontend/src/config/integrations.ts`) statuses on "planned" until step 5
   passes for that provider.

## Rollback

- Code: redeploy the previous Railway deployment (or revert the merge commit). The old code ignores the
  new tables and columns, so no DB rollback is needed.
- Workers misbehaving: set `RUN_WORKERS=false` and redeploy (API keeps serving; queued jobs stay in
  `pgboss` and resume later).
- A single provider misbehaving: remove its client variables → connector shows "Not configured";
  existing connections remain but OAuth refresh will fail until restored.
- Full DB rollback (only if required): drop the three new tables, two enums, two columns and the
  `pgboss` schema — destructive, needs separate approval.
