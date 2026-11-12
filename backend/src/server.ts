import { createHash } from "node:crypto";
import type { Server } from "node:http";
import { env } from "./config/env.js";
import { logger } from "./lib/logger.js";
import { prisma } from "./db/client.js";
import { createApp } from "./app.js";

const app = createApp({ db: prisma });

// Non-reversible key fingerprint: lets operators confirm the credentials key is stable across deploys.
logger.info(
  { keyVersion: env.CREDENTIALS_KEY_VERSION, keyFingerprint: createHash("sha256").update(env.CREDENTIALS_KEY).digest("hex").slice(0, 12) },
  "credentials key loaded",
);

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
    await prisma.$disconnect();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
