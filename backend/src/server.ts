import { serve } from "@hono/node-server";
import type { Server } from "node:http";
import { app } from "./app.js";

const port = Number(process.env.PORT ?? 4000);

/**
 * Listen on "::" (IPv6 + IPv4), which Railway needs for public and private networking.
 * Hosts without IPv6 fall back to 0.0.0.0. Override with HOST if needed.
 */
function start(hostname: string): Server {
  const server = serve({ fetch: app.fetch, port, hostname }, (info) => {
    console.log(`telzyra-api listening on ${hostname}:${info.port}`);
  }) as Server;
  server.once("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EAFNOSUPPORT" && hostname === "::") {
      current = start("0.0.0.0");
      return;
    }
    throw err;
  });
  return server;
}

let current = start(process.env.HOST ?? "::");

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    current.close(() => process.exit(0));
  });
}
