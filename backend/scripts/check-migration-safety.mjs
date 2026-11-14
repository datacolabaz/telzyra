#!/usr/bin/env node
/**
 * Verifies that pending migrations are safe for a database that already holds production-like data.
 *
 *   node scripts/check-migration-safety.mjs <disposable database url> [baseline migration name]
 *
 * 1. Recreates the public schema and applies migrations up to the baseline (default: all but the
 *    newest), i.e. the state production is in.
 * 2. Seeds realistic data in every existing table.
 * 3. Fingerprints every existing table (row count + hash of the columns that existed before).
 * 4. Statically rejects destructive statements in the pending migrations.
 * 5. Applies the pending migrations in one transaction with lock_timeout / statement_timeout,
 *    as `prisma migrate deploy` would, and measures the time.
 * 6. Re-fingerprints: existing rows must be byte-for-byte unchanged.
 *
 * Never point this at a real database: step 1 drops the schema. The URL must contain "check" or "test".
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";

const url = process.argv[2];
if (!url || !/check|test/i.test(new URL(url).pathname)) {
  console.error("Usage: check-migration-safety.mjs <postgres url of a disposable *check* or *test* database> [baseline]");
  process.exit(2);
}
const dir = join(import.meta.dirname, "../prisma/migrations");
const all = readdirSync(dir).filter((d) => /^\d+_/.test(d)).sort();
const baseline = process.argv[3] ?? all.at(-2);
const applied = all.slice(0, all.indexOf(baseline) + 1);
const pending = all.slice(all.indexOf(baseline) + 1);
if (!pending.length) {
  console.log("No pending migrations after", baseline);
  process.exit(0);
}

const DESTRUCTIVE = [
  /\bDROP\s+(TABLE|COLUMN|TYPE|SCHEMA|INDEX)\b/i,
  /\bALTER\s+COLUMN\s+"?\w+"?\s+(SET\s+DATA\s+)?TYPE\b/i,
  /\bSET\s+NOT\s+NULL\b/i,
  /\bTRUNCATE\b/i,
  /\bDELETE\s+FROM\b/i,
  /\bUPDATE\s+"?\w+"?\s+SET\b/i,
  /\bRENAME\b/i,
  /\bADD\s+COLUMN\s+"?\w+"?\s+[^,;]*\bNOT\s+NULL\b(?![^,;]*\bDEFAULT\b)/i,
];

const client = new pg.Client({ connectionString: url });
await client.connect();
const q = (sql, params) => client.query(sql, params);
let failed = false;
const fail = (msg) => {
  failed = true;
  console.error("✗", msg);
};

// 1. Baseline schema
await q("DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;");
for (const m of applied) await q(readFileSync(join(dir, m, "migration.sql"), "utf8"));
console.log(`baseline: ${applied.join(", ")}`);

// 2. Seed (shape of production data after Module 1)
await q(`
  INSERT INTO users (id, email, name, "passwordHash", locale, "updatedAt")
    SELECT gen_random_uuid(), 'user'||i||'@example.com', 'User '||i, '$argon2id$v=19$m=19456,t=2,p=1$x$y', 'az', now() FROM generate_series(1,200) i;
  INSERT INTO workspaces (id, name, slug, "updatedAt")
    SELECT gen_random_uuid(), 'WS '||i, 'ws-'||i, now() FROM generate_series(1,200) i;
  INSERT INTO memberships (id, "userId", "workspaceId", role)
    SELECT gen_random_uuid(), u.id, w.id, 'OWNER' FROM (SELECT id, row_number() OVER (ORDER BY email) r FROM users) u
    JOIN (SELECT id, row_number() OVER (ORDER BY slug) r FROM workspaces) w USING (r);
  INSERT INTO sessions (id, "tokenHash", "userId", "workspaceId", "expiresAt")
    SELECT gen_random_uuid(), md5(random()::text)||md5(random()::text), m."userId", m."workspaceId", now() + interval '30 days' FROM memberships m;
  INSERT INTO audit_logs (id, "workspaceId", "actorUserId", action, metadata)
    SELECT gen_random_uuid(), m."workspaceId", m."userId", 'auth.login.success', '{"ip":"1.2.3.4"}' FROM memberships m, generate_series(1,5);
  INSERT INTO connections (id, "workspaceId", provider, "authType", "externalAccountId", "displayName", scopes, "createdById", "updatedAt")
    SELECT gen_random_uuid(), m."workspaceId", 'telegram', 'BOT_TOKEN', 'bot'||row_number() OVER (), 'Bot', '{}', m."userId", now() FROM memberships m LIMIT 50;
  INSERT INTO credentials (id, "connectionId", secret, "keyVersion", "updatedAt")
    SELECT gen_random_uuid(), c.id, 'tz1.1.iv.tag.ct', 1, now() FROM connections c;
  INSERT INTO oauth_states (id, "stateHash", "workspaceId", "userId", "sessionId", provider, "codeVerifier", "redirectPath", "expiresAt")
    SELECT gen_random_uuid(), md5(random()::text), s."workspaceId", s."userId", s.id, 'google', 'enc', '/dashboard', now() + interval '10 minutes' FROM sessions s LIMIT 20;
  INSERT INTO webhook_subscriptions (id, "workspaceId", "connectionId", provider, "eventTypes", "endpointToken", "updatedAt")
    SELECT gen_random_uuid(), c."workspaceId", c.id, 'telegram', '{}', md5(random()::text), now() FROM connections c LIMIT 10;
  INSERT INTO webhook_events (id, provider, "dedupeKey", payload)
    SELECT gen_random_uuid(), 'telegram', 'k'||i, '{"update_id":1}' FROM generate_series(1,100) i;
`).catch((e) => {
  console.error("Seeding failed (baseline schema changed?):", e.message);
  process.exit(1);
});

// 3. Fingerprint existing tables over the columns that exist now
async function fingerprint() {
  const tables = (await q(`SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY 1`)).rows.map((r) => r.table_name);
  const out = {};
  for (const t of tables) {
    const cols = (await q(`SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 ORDER BY ordinal_position`, [t])).rows.map((r) => r.column_name);
    out[t] = { cols };
  }
  return out;
}
async function hashTable(t, cols) {
  const list = cols.map((c) => `"${c}"`).join(", ");
  const r = await q(`SELECT count(*)::int AS n, coalesce(md5(string_agg(row_to_json(x)::text, '|' ORDER BY row_to_json(x)::text)), '') AS h FROM (SELECT ${list} FROM "${t}") x`);
  return r.rows[0];
}
const before = await fingerprint();
for (const [t, v] of Object.entries(before)) Object.assign(v, await hashTable(t, v.cols));

// 4. Static check
for (const m of pending) {
  const sql = readFileSync(join(dir, m, "migration.sql"), "utf8").replace(/--.*$/gm, "");
  for (const re of DESTRUCTIVE) {
    const hit = sql.match(re);
    if (hit) fail(`${m}: destructive statement "${hit[0]}"`);
  }
}

// 5. Apply like prisma migrate deploy (one transaction per migration), with lock guards
for (const m of pending) {
  const sql = readFileSync(join(dir, m, "migration.sql"), "utf8");
  const started = Date.now();
  try {
    await q("BEGIN");
    await q("SET LOCAL lock_timeout = '5s'; SET LOCAL statement_timeout = '60s';");
    await q(sql);
    await q("COMMIT");
    console.log(`applied ${m} in ${Date.now() - started} ms`);
  } catch (e) {
    await q("ROLLBACK");
    fail(`${m} failed: ${e.message}`);
  }
}

// 6. Existing data unchanged
for (const [t, v] of Object.entries(before)) {
  const now = await hashTable(t, v.cols);
  if (now.n !== v.n || now.h !== v.h) fail(`table ${t} changed (${v.n} → ${now.n} rows)`);
  else console.log(`✓ ${t}: ${v.n} rows unchanged`);
}
const after = await fingerprint();
for (const [t, v] of Object.entries(after)) {
  if (!before[t]) console.log(`+ new table ${t}`);
  else for (const c of v.cols.filter((c) => !before[t].cols.includes(c))) console.log(`+ new column ${t}.${c}`);
}

await client.end();
console.log(failed ? "\nMIGRATION CHECK FAILED" : "\nMigration check passed: additive only, existing data intact.");
process.exit(failed ? 1 : 0);
