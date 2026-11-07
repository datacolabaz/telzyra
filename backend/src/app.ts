import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { PLANS } from "./plans.js";

/**
 * Telzyra Platform API.
 *
 * Phase 1 serves only real, working data: health and the plan catalogue.
 * Account endpoints exist so the contract is fixed, but they return
 * 503 "service.unavailable" until user storage and auth land in phase 2.
 * The frontend already shows that code as a localized message.
 */
export const app = new Hono();

const allowedOrigins = (process.env.CORS_ORIGINS ?? "http://localhost:3000")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

app.use("*", logger());
app.use("/v1/*", cors({ origin: allowedOrigins, credentials: true }));

app.get("/", (c) => c.json({ name: "telzyra-api", status: "ok" }));

app.get("/health", (c) =>
  c.json({ status: "ok", uptime: Math.round(process.uptime()), version: process.env.RAILWAY_GIT_COMMIT_SHA ?? "dev" }),
);

app.get("/v1/plans", (c) => {
  c.header("Cache-Control", "public, max-age=300");
  return c.json(PLANS);
});

const notYetAvailable = () =>
  new Response(JSON.stringify({ code: "service.unavailable" }), {
    status: 503,
    headers: { "Content-Type": "application/json", "Retry-After": "3600" },
  });

app.post("/v1/auth/register", notYetAvailable);
app.post("/v1/auth/login", notYetAvailable);

app.notFound((c) => c.json({ code: "not_found" }, 404));
app.onError((err, c) => {
  console.error(err);
  return c.json({ code: "unknown" }, 500);
});
