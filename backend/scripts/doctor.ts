/**
 * Pre-flight check for running Telzyra against real providers (local or production).
 *   npm run doctor
 * Prints only variable NAMES and derived URLs — never secret values.
 */
import pg from "pg";
import { env } from "../src/config/env.js";
import { redirectUriFor } from "../src/integrations/oauth/oauth.service.js";
import { telegramTriggerMode } from "../src/integrations/providers/telegram.js";

let problems = 0;
const ok = (m: string) => console.log(`  ✓ ${m}`);
const warn = (m: string) => console.log(`  ! ${m}`);
const bad = (m: string) => {
  problems++;
  console.log(`  ✗ ${m}`);
};

console.log("\nCore");
ok(`NODE_ENV=${env.NODE_ENV}, APP_URL=${env.APP_URL}, PUBLIC_API_URL=${env.PUBLIC_API_URL}`);
if (!env.CORS_ORIGINS.includes(new URL(env.APP_URL).origin)) bad("CORS_ORIGINS must include the APP_URL origin");
else ok("CORS_ORIGINS includes APP_URL");
const localApp = new URL(env.APP_URL).hostname === "localhost";
if (localApp && env.COOKIE_DOMAIN) bad("COOKIE_DOMAIN must be empty for localhost");
if (!localApp && !env.COOKIE_DOMAIN) warn("COOKIE_DOMAIN is empty: app and API on different subdomains will not share the session");
if (env.NODE_ENV === "production" && !env.PUBLIC_API_URL.startsWith("https://")) bad("PUBLIC_API_URL must be https in production");

console.log("\nDatabase");
const client = new pg.Client({ connectionString: env.DATABASE_URL });
try {
  await client.connect();
  ok("connected");
  const migrations = await client.query(`SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL ORDER BY migration_name`).catch(() => null);
  const tables = await client.query(`SELECT to_regclass('public.workflows') AS w, to_regclass('public.workflow_executions') AS e`);
  if (migrations) ok(`migrations applied: ${migrations.rows.map((r) => r.migration_name).join(", ") || "none"}`);
  if (!tables.rows[0].w || !tables.rows[0].e) bad("workflow tables missing — run: npx prisma migrate deploy");
  else ok("workflow tables present");
} catch (e) {
  bad(`cannot connect (${e instanceof Error ? e.message : "error"}) — is Postgres running? (npm run db:local)`);
} finally {
  await client.end().catch(() => undefined);
}

console.log("\nTelegram");
const mode = telegramTriggerMode();
ok(`trigger delivery: ${mode}${mode === "polling" ? " (getUpdates every minute; works without a public URL)" : ` (webhook at ${env.PUBLIC_API_URL}/webhooks/telegram/<token>)`}`);
ok("bot token is entered in the UI (Integrations → Telegram), not in .env");

console.log("\nGoogle (Sheets/Gmail)");
if (env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) {
  ok("GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are set");
  if (!/\.apps\.googleusercontent\.com$/.test(env.GOOGLE_CLIENT_ID)) warn("GOOGLE_CLIENT_ID does not look like a Google OAuth client id");
  console.log(`    Authorized redirect URI to register in Google Cloud: ${redirectUriFor("google")}`);
} else bad("GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET missing — Google Sheets will show “Not configured”");

console.log("\nOutbound network");
for (const [name, url] of [["Telegram API", "https://api.telegram.org/"], ["Google OAuth", "https://oauth2.googleapis.com/"], ["Google Sheets API", "https://sheets.googleapis.com/"]] as const) {
  try {
    await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(8000) });
    ok(`${name} reachable`);
  } catch {
    bad(`${name} not reachable from this machine (${new URL(url).host})`);
  }
}

console.log(problems ? `\n${problems} problem(s) found.\n` : "\nAll checks passed.\n");
process.exit(problems ? 1 : 0);
