// Recreates the E2E database schema from the committed migrations. Refuses non-e2e databases.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
const url = process.env.E2E_DATABASE_URL ?? "postgresql://telzyra:telzyra@localhost:54329/telzyra_e2e";
if (!/e2e/.test(new URL(url).pathname)) throw new Error("E2E_DATABASE_URL must point to an *e2e* database");
const admin = new pg.Client({ connectionString: url.replace(/\/[^/]+$/, "/postgres") });
await admin.connect();
const db = new URL(url).pathname.slice(1);
await admin.query(`DROP DATABASE IF EXISTS "${db}" WITH (FORCE)`);
await admin.query(`CREATE DATABASE "${db}"`);
await admin.end();
const c = new pg.Client({ connectionString: url });
await c.connect();
const dir = join(import.meta.dirname, "../backend/prisma/migrations");
for (const m of readdirSync(dir).filter((d) => /^\d+_/.test(d)).sort()) await c.query(readFileSync(join(dir, m, "migration.sql"), "utf8"));
await c.end();
console.log(`reset ${db}`);
