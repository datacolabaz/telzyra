#!/usr/bin/env node
/**
 * Local webhook gateway for HTTPS tunnels.
 *
 *   node scripts/webhook-gateway.mjs [listenPort=4001] [apiOrigin=http://127.0.0.1:4000]
 *
 * A tunnel (e.g. cloudflared) points at this port instead of the API, so the internet can reach ONLY
 * POST /webhooks/* (and GET /health). Everything else — /v1 (sessions, OAuth, connections) — returns
 * 404 and never reaches the API. Bodies are streamed unchanged, so provider signatures stay valid.
 */
import http from "node:http";

const port = Number(process.argv[2] ?? 4001);
const api = new URL(process.argv[3] ?? "http://127.0.0.1:4000");
const MAX_BODY = 1024 * 1024; // the API enforces the same limit

export function allowed(method, url) {
  const path = (url ?? "/").split("?")[0];
  if (method === "GET" && path === "/health") return true;
  return method === "POST" && /^\/webhooks\/[a-z0-9-]+(\/[A-Za-z0-9_-]+)*$/.test(path);
}

const server = http.createServer((req, res) => {
  if (!allowed(req.method, req.url)) {
    res.writeHead(404, { "content-type": "application/json" }).end('{"code":"not_found"}');
    return;
  }
  const headers = { ...req.headers, host: api.host };
  delete headers.cookie; // webhooks never carry a Telzyra session
  const upstream = http.request({ hostname: api.hostname, port: api.port, method: req.method, path: req.url, headers }, (up) => {
    res.writeHead(up.statusCode ?? 502, up.headers);
    up.pipe(res);
  });
  upstream.on("error", () => {
    if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
    res.end('{"code":"upstream_unavailable"}');
  });
  let size = 0;
  req.on("data", (chunk) => {
    size += chunk.length;
    if (size > MAX_BODY) {
      res.writeHead(413).end();
      req.destroy();
      upstream.destroy();
    }
  });
  req.pipe(upstream);
});

if (import.meta.url === `file://${process.argv[1]}`) {
  server.listen(port, "127.0.0.1", () => console.log(`webhook gateway on :${port} → ${api.origin} (only /webhooks/* and /health)`));
}
