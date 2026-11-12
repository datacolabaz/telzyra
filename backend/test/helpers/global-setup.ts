import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";

/** Recreates the test schema from the committed migrations (same SQL that runs in production). */
export default async function setup() {
  const url = process.env.TEST_DATABASE_URL ?? "postgresql://telzyra:telzyra@localhost:54329/telzyra_test";
  if (!/test/i.test(new URL(url).pathname)) throw new Error("Refusing to reset a database whose name does not contain 'test'");
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  await client.query("DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;");
  const dir = join(import.meta.dirname, "../../prisma/migrations");
  for (const name of readdirSync(dir).filter((d) => /^\d+_/.test(d)).sort()) {
    await client.query(readFileSync(join(dir, name, "migration.sql"), "utf8"));
  }
  await client.end();
}
