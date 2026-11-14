# Real-provider test on your computer: Telegram → Google Sheets → Telegram

Goal: from the Telzyra UI, connect a real Telegram bot and a real Google account, build the workflow, send
a message to the bot, and see the row in Google Sheets and the bot's reply.

Runs entirely on `localhost`; nothing is deployed. Telegram works without a public URL because Telzyra
polls `getUpdates` when `PUBLIC_API_URL` is localhost (replies arrive within ~1 minute).

Prerequisites: Node.js 22, the repository on branch `feature/integrations`.

## 1. Telegram bot (≈2 min, you)

1. In Telegram open **@BotFather** → `/newbot` → choose a name (e.g. *Telzyra Test*) and a username ending
   in `bot` (e.g. `telzyra_test_123_bot`).
2. BotFather replies with a token like `1234567890:AA…`. Keep it private; you will paste it only into the
   Telzyra UI (it is stored encrypted, never in `.env` or Git).
3. Open your new bot in Telegram and press **Start** (a bot cannot message you before you write to it).
4. Use a **new** bot: if the token is used by another service with a webhook, Telzyra removes that webhook.

## 2. Google Cloud OAuth client (≈10 min, you)

1. https://console.cloud.google.com → project selector → **New project** → `telzyra-dev`.
2. **APIs & Services → Library** → enable **Google Sheets API**.
3. **APIs & Services → OAuth consent screen** (Google Auth Platform):
   - App name `Telzyra (dev)`, support e-mail = your address, audience **External**.
   - **Audience → Test users → Add users**: the Google account you will connect.
   - **Data access → Add scopes**: `.../auth/userinfo.email`, `openid`, `.../auth/spreadsheets`.
   (Publishing status stays **Testing** — no verification needed for test users.)
4. **Clients → Create client** → *Web application*, name `Telzyra local`.
   - Authorized redirect URI: **`http://localhost:4000/v1/oauth/google/callback`** (exact).
   - Authorized JavaScript origins: not needed.
5. Copy the **Client ID** and **Client secret** into `backend/.env` (step 3 below) — not into chat.
6. Create a Google Sheet, rename the first tab to **`Leads`**, put headers in row 1
   (`Username | Message | Chat`). Copy the spreadsheet id from its URL:
   `https://docs.google.com/spreadsheets/d/<SPREADSHEET_ID>/edit`.

## 3. Run Telzyra locally

```bash
git fetch && git checkout feature/integrations && git pull

# Terminal 1 — database (no install needed; data in backend/.local-pg)
cd backend && npm install && npm run db:local

# Terminal 2 — API + workers
cd backend
cp .env.example .env            # first time only
# edit .env:
#   CREDENTIALS_KEY=<run: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))">
#   GOOGLE_CLIENT_ID=<from step 2>      GOOGLE_CLIENT_SECRET=<from step 2>
#   (keep DATABASE_URL, APP_URL, CORS_ORIGINS, PUBLIC_API_URL as in the example; COOKIE_DOMAIN empty)
npx prisma migrate deploy
npm run doctor                  # must end with "All checks passed."
npm run dev

# Terminal 3 — web app
cd frontend && npm install
cp .env.example .env.local      # points the app at http://localhost:4000
npm run dev
```

## 4. Test in the browser (http://localhost:3000)

1. **Register** a local account → Dashboard → **Open integrations**.
2. **Telegram → Connect** → paste the bot token → "Connected successfully" → **My connections → Test**.
3. **Google Sheets → Connect** → Google consent screen (choose the test-user account; "Google hasn't
   verified this app" → *Continue*) → back in Telzyra: "Connected successfully".
4. **Workflows → New workflow**, name `Leads from Telegram`:
   - Trigger: App **Telegram**, Event **New incoming message**.
   - **Add step** → Step name `save`, App **Google Sheets**, Action **Append row**,
     `spreadsheet_id` = your id, `sheet` = `Leads`,
     `values` = `["{{trigger.from.username}}", "{{trigger.text}}", "{{trigger.chat.id}}"]`.
     Press **Test step** → a sample row (`jane`, `Hello!`) appears in the sheet (delete it afterwards).
   - **Add step** → Step name `reply`, App **Telegram**, Action **Send message**,
     `chat_id` = `{{trigger.chat.id}}`, `text` = `Saved to {{steps.save.updated_range}}`.
   - **Save** → **Activate**.
5. Wait ~1 minute (first poll sets the starting point), then write to your bot: `Hi, I want a demo`.
6. Within ~1 minute: a new row in the sheet, and the bot replies `Saved to Leads!A3:C3`.
   **Runs** in the builder shows *Succeeded* with each step's output.
7. Optional: **My connections → Disconnect** Telegram → the workflow becomes *Paused*.

## If something fails

| Symptom | Cause / fix |
|---|---|
| Google Sheets shows "Not configured" | `GOOGLE_CLIENT_ID/SECRET` missing in `backend/.env`; restart `npm run dev` |
| Google: `redirect_uri_mismatch` | Redirect URI in Google Cloud must be exactly `http://localhost:4000/v1/oauth/google/callback` |
| Google: `access_denied` / "app is being tested" | Add your account under *Audience → Test users* |
| Back in Telzyra with "signed in with a different account" | Start the connection again in the same browser where you are logged in to Telzyra |
| Run fails `save: PERMISSION_DENIED` | The connected Google account has no edit access to that spreadsheet |
| Run fails `save: VALIDATION` | Wrong tab name (`sheet`) or spreadsheet id |
| No run after writing to the bot | Wait 1–2 min; check the workflow is *Active*; API log shows `trigger poll failed` with the reason |
| `workflow.trigger_in_use` | Only one active Telegram-trigger workflow per bot in local polling mode |

Send me the error code shown in **Runs** (never the token or secret) and I will fix it.
