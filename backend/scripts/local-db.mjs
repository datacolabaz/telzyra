#!/usr/bin/env node
/**
 * Local PostgreSQL without installing anything: runs the embedded-postgres binary from node_modules.
 *   npm run db:local      → starts Postgres on localhost:54329 (data in backend/.local-pg, kept between runs)
 * Databases: telzyra_dev (app), telzyra_test (vitest), telzyra_e2e (browser tests). User/password: telzyra/telzyra.
 * Local-only credentials; never use them anywhere else. Stop with Ctrl+C.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";

const dir = join(import.meta.dirname, "../.local-pg");
const pg = new EmbeddedPostgres({ databaseDir: dir, port: 54329, user: "telzyra", password: "telzyra", persistent: true, onLog: () => {} });
const fresh = !existsSync(join(dir, "PG_VERSION"));
if (fresh) await pg.initialise();
await pg.start();
if (fresh) for (const db of ["telzyra_dev", "telzyra_test", "telzyra_e2e"]) await pg.createDatabase(db);
console.log("PostgreSQL running on postgresql://telzyra:telzyra@localhost:54329 (databases: telzyra_dev, telzyra_test, telzyra_e2e). Ctrl+C to stop.");
const stop = async () => {
  await pg.stop();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
setInterval(() => {}, 1 << 30);
