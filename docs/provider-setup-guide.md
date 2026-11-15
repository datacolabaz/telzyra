# Provider Setup Guide

All URLs below come from the backend routing (`backend/src/integrations/integrations.routes.ts`,
`oauth.service.ts → redirectUriFor`). Production API base: **`https://api.telzyra.com`**
(`PUBLIC_API_URL`). For local development use `http://localhost:4000` and the provider's
development/test mode.

| Purpose | URL |
|---|---|
| OAuth redirect (callback) | `https://api.telzyra.com/v1/oauth/<oauth-provider>/callback` |
| App-level webhooks | `https://api.telzyra.com/webhooks/<connector>` |
| Per-connection webhooks | `https://api.telzyra.com/webhooks/<connector>/<endpointToken>` — registered automatically, nothing to configure |
| Local https-only OAuth (Slack, Shopify) | With `TELZYRA_TUNNEL=1` the redirect URI becomes `<tunnel>/v1/oauth/<provider>/callback`; the gateway 302-redirects it to `http://localhost:4000/…` so the session cookie is used |
| Local webhook testing | `TELZYRA_TUNNEL=1 bash scripts/real-test/start.sh` prints a `https://….trycloudflare.com` URL (changes each run); only `/webhooks/*` is reachable through it |

OAuth provider ids: `google` (Google Sheets, Gmail), `slack`, `notion`, `hubspot`, `shopify`, `meta` (Facebook Pages, Instagram).
After setting a variable on Railway, redeploy the backend. A connector whose variables are missing is
shown as "Not configured" in the UI and cannot be connected.

> Creating these apps, submitting them for verification and setting production secrets are
> owner actions; they were **not** performed as part of this work.

---

## Telegram (bot token)

1. In Telegram open **@BotFather** → `/newbot` → copy the token.
2. In Telzyra: Integrations → Telegram → Connect → paste the token. Telzyra calls `getMe` before saving.
3. Activating a workflow with a Telegram trigger calls `setWebhook` with a random `secret_token`.
   Telegram allows one webhook per bot: a bot used elsewhere (or with `getUpdates`) will be taken over.
4. No server variables needed.

## Google (Google Sheets, Gmail)

1. Google Cloud Console → create project → **APIs & Services → Library**: enable *Google Sheets API*
   and *Gmail API*.
2. **OAuth consent screen**: External, app name "Telzyra", support e-mail, authorized domain `telzyra.com`,
   privacy policy `https://telzyra.com/privacy`, terms `https://telzyra.com/terms`.
   Scopes: `openid`, `.../auth/userinfo.email`, `.../auth/spreadsheets`, `.../auth/gmail.send`, `.../auth/gmail.readonly`.
3. **Credentials → Create OAuth client ID → Web application**.
   Authorized redirect URI: **`https://api.telzyra.com/v1/oauth/google/callback`**
   (local: `http://localhost:4000/v1/oauth/google/callback`).
4. Railway backend variables: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`.
5. Verification: while the app is in *Testing*, only listed test users can connect and refresh tokens
   expire after 7 days. `spreadsheets` and `gmail.send` are *sensitive* scopes (Google verification).
   `gmail.readonly` is *restricted*: public use requires verification **and an annual third-party
   security assessment (CASA)**. Option: ship Gmail send-only first (remove `gmail.readonly` and the
   read/search/trigger features) to avoid the assessment.

## Slack

1. https://api.slack.com/apps → **Create New App** → From scratch.
2. **OAuth & Permissions** → Redirect URL: **`https://api.telzyra.com/v1/oauth/slack/callback`**.
   Bot token scopes: `chat:write`, `channels:read`, `channels:history`, `im:write`.
   (Enable *token rotation* if desired — refresh is supported.)
3. **Event Subscriptions** → On → Request URL: **`https://api.telzyra.com/webhooks/slack`**
   (Slack sends `url_verification`; Telzyra answers it after checking the signature).
   Subscribe to bot events: `message.channels`, `app_mention`.
4. **Basic Information** → copy Client ID, Client Secret, Signing Secret.
5. Railway: `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`, `SLACK_SIGNING_SECRET`.
6. Distribution to other workspaces requires **Manage Distribution** (public distribution); Slack
   Marketplace listing is a separate review.

## Notion

1. https://www.notion.so/profile/integrations → **New integration** → type **Public**.
2. Redirect URI: **`https://api.telzyra.com/v1/oauth/notion/callback`**. Capabilities: read, update, insert content.
3. Railway: `NOTION_CLIENT_ID`, `NOTION_CLIENT_SECRET`. API version used: `2025-09-03`.
4. Webhooks (optional; polling trigger works without them): integration → **Webhooks** → URL
   **`https://api.telzyra.com/webhooks/notion`**, events `page.created`, `page.properties_updated`,
   `page.content_updated`. Notion posts a one-time `verification_token`; Telzyra stores it encrypted.
   On the server run `npm run notion:verification-token` (backend), paste the value in Notion to verify,
   then set `NOTION_WEBHOOK_VERIFICATION_TOKEN` to the same value and redeploy (it signs all deliveries).
5. Users choose which pages Telzyra can access during consent; pages not shared are invisible.

## HubSpot

1. https://developers.hubspot.com → developer account → **Create app** (public app).
2. Auth: redirect URL **`https://api.telzyra.com/v1/oauth/hubspot/callback`**; scopes `oauth`,
   `crm.objects.contacts.read`, `crm.objects.contacts.write`, `crm.objects.deals.read`, `crm.objects.deals.write`.
3. Webhooks: target URL **`https://api.telzyra.com/webhooks/hubspot`**; subscriptions
   `contact.creation`, `contact.propertyChange` (choose properties), `deal.creation`.
4. Railway: `HUBSPOT_CLIENT_ID`, `HUBSPOT_CLIENT_SECRET`, `HUBSPOT_APP_ID`.
   The client secret also verifies `X-HubSpot-Signature-v3`.
5. Marketplace listing is optional and has its own review.

## Stripe (API key)

1. Stripe Dashboard → Developers → API keys → **Create restricted key**. Minimum permissions:
   Customers write, Payment Links write, Prices read, PaymentIntents read, Webhook Endpoints write
   (needed so Telzyra can create the endpoint for triggers).
2. In Telzyra: Integrations → Stripe → paste the key. Use a **test-mode** key (`rk_test_…`) first.
3. Activating a workflow with a Stripe trigger creates a webhook endpoint for
   `payment_intent.succeeded` and `payment_intent.payment_failed`; its signing secret is stored encrypted.
   Disconnecting deletes the endpoint.
4. No server variables needed.

## Shopify

1. Shopify Partners (or Dev Dashboard) → **Create app** → set App URL `https://telzyra.com/dashboard/integrations`.
2. Allowed redirection URL: **`https://api.telzyra.com/v1/oauth/shopify/callback`**.
3. Scopes requested: `read_orders`, `read_products`, `read_inventory`, `write_inventory`, `read_locations`.
4. **Mandatory compliance webhooks** (all three): **`https://api.telzyra.com/webhooks/shopify/compliance`**
   for `customers/data_request`, `customers/redact`, `shop/redact`.
5. Railway: `SHOPIFY_CLIENT_ID`, `SHOPIFY_CLIENT_SECRET`, optional `SHOPIFY_API_VERSION` (default `2026-10`).
6. Orders contain *protected customer data*: request access in the app's **API access** section
   (required for public apps; development stores work without approval). Public distribution
   requires Shopify app review.
7. Users connect by entering their `*.myshopify.com` domain. Order webhooks are registered per shop
   with `webhookSubscriptionCreate` (`uri` field).

## Meta: Facebook Pages and Instagram

One Meta app serves both connectors (OAuth provider id `meta`).

1. https://developers.facebook.com → **My Apps → Create app** → use case **"Other"** → type **Business**.
2. Add the product **Facebook Login for Business**. Valid OAuth Redirect URIs:
   **`https://api.telzyra.com/v1/oauth/meta/callback`** (local: `http://localhost:4000/v1/oauth/meta/callback`;
   Meta allows `localhost` only while the app is in Development mode).
3. Permissions requested: Facebook Pages → `pages_show_list`, `pages_read_engagement`, `pages_manage_posts`,
   `business_management`; Instagram → `instagram_basic`, `instagram_content_publish`, `pages_show_list`,
   `pages_read_engagement`, `business_management`.
4. App settings → Basic → App ID / App Secret → Railway `META_APP_ID`, `META_APP_SECRET` (optional `META_GRAPH_VERSION`, default `v27.0`).
5. Accounts: a Facebook **Page** (personal profiles cannot be posted to by any API) and an Instagram
   **Business or Creator** account linked to that Page (Instagram app → Settings → Account type; Page settings → Linked accounts).
6. Development mode: people with a role on the app (admin/developer/tester) can connect without review.
   Public use: **Business verification** + **App Review** (Advanced Access) for each permission, with a
   screencast of connecting and publishing in Telzyra. Plan for days to weeks.
7. Media for Instagram must be a public **https** URL; images JPEG only; reels MP4. Limit: 100 API posts per
   account per 24 h (Telzyra checks `content_publishing_limit` before publishing).

## Core: HTTP Request

No setup. Calls only public addresses; redirects are not followed.
