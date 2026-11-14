import { createHash } from "node:crypto";
import type { Server } from "node:http";
import { env } from "./config/env.js";
import { logger } from "./lib/logger.js";
import { cipher, prisma } from "./db/client.js";
import { createApp } from "./app.js";
import { createServices, jobHandlers } from "./container.js";
import { PgBossQueue } from "./queue/queue.js";
import { setDefaultBreaker } from "./integrations/core/http.js";
import { PgCircuitBreaker } from "./integrations/core/shared-breaker.js";

// Circuit-breaker state is shared by all instances through Postgres.
const breaker = new PgCircuitBreaker(prisma);
setDefaultBreaker(breaker);
const queue = new PgBossQueue(env.DATABASE_URL);
const services = createServices(prisma, cipher, queue, { breaker });
const app = createApp({ db: prisma, services });

// Queue workers (webhook processing, workflow execution, polling). RUN_WORKERS=false keeps
// this instance API-only, e.g. when a separate worker service is added later.
queue
  .start(jobHandlers(services), env.RUN_WORKERS)
  .catch((err) => logger.error({ err: err instanceof Error ? err.message : "unknown" }, "queue failed to start"));

// Non-reversible key fingerprint: lets operators confirm the credentials key is stable across deploys.
const keyFingerprint = createHash("sha256").update(env.CREDENTIALS_KEY).digest("hex").slice(0, 12);
logger.info(`credentials key loaded (version ${env.CREDENTIALS_KEY_VERSION}, fingerprint ${keyFingerprint})`);

/**
 * Listen on "::" (IPv6 + IPv4) as Railway requires for private networking;
 * hosts without IPv6 fall back to 0.0.0.0. Override with HOST.
 */
function start(host: string): Server {
  const server = app.listen(env.PORT, host, () => logger.info({ host, port: env.PORT }, "telzyra-api listening"));
  server.once("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EAFNOSUPPORT" && host === "::") {
      current = start("0.0.0.0");
      return;
    }
    logger.fatal({ err }, "server failed to start");
    process.exit(1);
  });
  return server;
}

let current = start(env.HOST);

async function shutdown(signal: string) {
  logger.info({ signal }, "shutting down");
  current.close(async () => {
    await queue.stop().catch(() => undefined);
    await prisma.$disconnect();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
