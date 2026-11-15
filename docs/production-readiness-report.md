# Telzyra Integrations — Production Readiness Report

Date: 2026-11-15 · Branch: `feature/integrations` (not merged, not deployed) · Scope: Telegram → Google Sheets → Telegram

## 1. Real-provider acceptance test (no mocks)

Environment: the owner's Mac (macOS, arm64), Telzyra started with `scripts/real-test/start.sh`
(embedded PostgreSQL, API + pg-boss workers on :4000, web app on :3001). Driven through the real
Telzyra UI in the Claude desktop app's browser pane. Providers: the real Telegram Bot API and Google
APIs; Google Cloud project `telzyra-test` (OAuth app in *Testing*, test user `ugctelman@gmail.com`).

| Check | Result | Evidence |
|---|---|---|
| Register / log in through the UI | ✅ | Dashboard for the new local account |
| Connect Telegram with a real bot token | ✅ | Connection *Active*, account `@telzyra_test_bot` (real `getMe`) |
| Test connection | ✅ | "Connection works (111 ms)" |
| Connect Google Sheets via real OAuth (PKCE, consent) | ✅ | Callback `status=connected`; connection *Active* for `ugctelman@gmail.com` |
| Build workflow in the builder (trigger + 2 steps, templates) | ✅ | Saved, then *Active* |
| Telegram message is received | ✅ | Updates `169561002` (`/start`) and `169561003` (`salam necesen dostum`) picked up by polling |
| New row in Google Sheets | ✅ | `Sheet1!A2:D2`, `Sheet1!A3:D3`; confirmed by an independent `read_rows` call against the real Sheets API |
| Telegram replies to the user | ✅ | `sendMessage` returned message ids 3 and 4 in chat 6144921946 |
| Execution history | ✅ | 2 runs, *Succeeded*, source *Polling*, trigger data + per-step outputs visible in **Runs** |
| No duplicate processing | ✅ | After ≥4 further poll cycles still exactly 2 executions (unique `new_message:<update_id>`), 2 rows |
| OAuth token refresh | ✅ | Access token had expired overnight; refreshed automatically before the run (`oauth token refreshed`) |
| Disconnect stops safely | ✅ | Telegram → *Disconnected*, credentials deleted, workflow automatically *Paused* |

Not covered by the real test: Telegram **webhook** delivery (needs a public HTTPS API — production
only; covered by mocked integration tests), failure retry/DLQ with real providers, multi-instance
behaviour, load.

## 2. Engineering work completed before the test

| Item | Status |
|---|---|
| SSRF: connect-time DNS validation (rebinding), no proxy, no redirects, IPv6-embedded IPv4 | ✅ tests incl. real rebinding attempt |
| Retention: runs + webhook payloads, default 30 days, audit untouched | ✅ |
| Circuit breaker shared across instances (Postgres) | ✅ |
| Prisma schema drift check | ✅ GitHub Actions (real Prisma engine) and on the Mac run (`start.sh`) |
| Migration safety on production-like data | ✅ additive only, existing rows unchanged |
| Tests | Backend 140 ✅ · Browser E2E (Playwright, fake providers) 13 ✅ · CI ✅ |

## 3. Bugs found during real testing (and fixed)

1. Embedded browsers block cross-port `localhost` requests → optional same-origin API proxy (`TELZYRA_API_PROXY`, off in production).
2. `start.sh`: refused to run when port 3000 was busy → picks the next free port, shows the process using it.
3. `start.sh`: an `.env` copied from the example had an empty encryption key → missing keys are filled.
4. `start.sh`: disk-space pre-check (installation failed earlier with `ENOSPC`).
5. App navigation was hidden on narrow screens → always visible.

## 4. Open items before production

| # | Item | Severity | Owner action |
|---|---|---|---|
| 1 | **Rotate the Telegram test bot token** — it was pasted in a chat | High | BotFather → `/revoke` |
| 2 | Set `PUBLIC_API_URL=https://api.telzyra.com` (and review all variables in `production-env.md`) | Blocker | Railway variables (needs approval) |
| 3 | Production Google OAuth client with redirect `https://api.telzyra.com/v1/oauth/google/callback`; consent-screen branding; verification for public use (Sheets scope is *sensitive*) | Blocker for public users | Google Cloud |
| 4 | Telegram webhook mode has only mocked coverage → verify on staging/production right after release with one bot | Medium | Post-release check |
| 5 | Privacy policy: mention 30-day retention of run history and webhook payloads | Medium | Content |
| 6 | Telegram trigger also fires on bot commands (`/start` became a row) → add an "ignore commands" option | Low (product) | Backlog |
| 7 | Plural forms in catalog ("1 actions") | Low | Backlog |
| 8 | Polling during sleep/network loss logs `TIMEOUT` and recovers — expected; add alerting on repeated poll failures in production | Low | Backlog |

## 5. Release procedure (unchanged, requires owner approval)

See `integrations-deployment.md`: review PR → set `PUBLIC_API_URL` → merge → pre-deploy runs
`migrate deploy` + drift check → smoke test → enable providers one by one. Rollback: redeploy previous
version; migrations are additive so no DB rollback is needed.
