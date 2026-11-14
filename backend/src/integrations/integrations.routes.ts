import express, { Router, type NextFunction, type Request, type Response } from "express";
import { ipKeyGenerator, rateLimit } from "express-rate-limit";
import { env } from "../config/env.js";
import { AppError, Errors } from "../lib/errors.js";
import { requireAuth, requireRole } from "../auth/middleware.js";
import type { Services } from "../container.js";
import { describeConnector, getConnector, listConnectors } from "./core/registry.js";
import { publicConnection } from "./connections/connection.service.js";
import type { RawWebhookRequest } from "./core/types.js";

type Handler = (req: Request, res: Response) => Promise<unknown>;
const h = (fn: Handler) => (req: Request, res: Response, next: NextFunction) => fn(req, res).catch(next);
const str = (v: unknown, max = 200) => (typeof v === "string" ? v.slice(0, max) : undefined);
const manage = requireRole("OWNER", "ADMIN");

/**
 * /v1 routes for integrations, connections, OAuth and workflows.
 * Every route requires a session; state-changing routes also require the CSRF token
 * (requireAuth). Managing connections requires OWNER or ADMIN.
 */
export function integrationsRouter(s: Services) {
  const r = Router();

  // ── OAuth callback: top-level browser navigation from the provider, so it cannot carry the
  // CSRF header. Protection = single-use state bound to the session (checked in OAuthService).
  r.get("/oauth/:providerId/callback", h(async (req, res) => {
    const query = Object.fromEntries(Object.entries(req.query).filter(([, v]) => typeof v === "string")) as Record<string, string>;
    const target = await s.oauth.callback(String(req.params.providerId), query, req.auth, req);
    res.redirect(303, target);
  }));

  r.use(["/integrations", "/connections", "/oauth", "/workflows", "/executions", "/webhook-events"], requireAuth);

  // ── Catalog ────────────────────────────────────────────────────────────────
  r.get("/integrations", h(async (_req, res) => res.json(listConnectors().map(describeConnector))));
  r.get("/integrations/:id", h(async (req, res) => {
    const def = getConnector(String(req.params.id));
    if (!def) throw Errors.notFound();
    res.json(describeConnector(def));
  }));

  // ── Connections ────────────────────────────────────────────────────────────
  r.get("/connections", h(async (req, res) => res.json(await s.connections.list(req.auth!.workspaceId))));
  r.get("/connections/:id", h(async (req, res) => res.json(publicConnection(await s.connections.get(req.auth!.workspaceId, String(req.params.id))))));
  r.post("/connections", manage, h(async (req, res) => {
    const connector = str(req.body?.connector, 50);
    const secret = str(req.body?.secret, 500);
    if (!connector || !secret) throw Errors.validation({ secret: { code: "required" } });
    res.status(201).json(await s.connections.createWithSecret(req.auth!, connector, secret.trim(), req));
  }));
  r.post("/connections/:id/test", manage, h(async (req, res) => res.json(await s.connections.test(req.auth!, String(req.params.id), req))));
  r.post("/connections/:id/reauthorize", manage, h(async (req, res) => {
    const c = await s.connections.get(req.auth!.workspaceId, String(req.params.id));
    const def = getConnector(c.provider);
    if (def?.auth.type !== "oauth2") throw new AppError(400, "connection.reauthorize_not_supported");
    const url = await s.oauth.start(req.auth!, c.provider, { redirectPath: str(req.body?.redirectPath, 300), connectionId: c.id, shop: c.provider === "shopify" ? (c.externalAccountId ?? undefined) : undefined });
    res.json({ url });
  }));
  r.post("/connections/:id/disconnect", manage, h(async (req, res) => res.json(await s.connections.disconnect(req.auth!, String(req.params.id), req))));
  r.delete("/connections/:id", manage, h(async (req, res) => {
    await s.connections.remove(req.auth!, String(req.params.id), req);
    res.status(204).end();
  }));

  r.post("/oauth/:connectorId/start", manage, h(async (req, res) => {
    const url = await s.oauth.start(req.auth!, String(req.params.connectorId), { redirectPath: str(req.body?.redirectPath, 300), shop: str(req.body?.shop, 100) });
    res.json({ url });
  }));

  // ── Workflows ──────────────────────────────────────────────────────────────
  r.get("/workflows", h(async (req, res) => res.json(await s.workflows.list(req.auth!))));
  r.post("/workflows", h(async (req, res) => res.status(201).json(await s.workflows.create(req.auth!, req.body ?? {}, req))));
  r.post("/workflows/test-step", h(async (req, res) => res.json(await s.workflows.testStep(req.auth!, req.body ?? {}, req))));
  r.get("/workflows/:id", h(async (req, res) => res.json(await s.workflows.get(req.auth!, String(req.params.id)))));
  r.patch("/workflows/:id", h(async (req, res) => res.json(await s.workflows.update(req.auth!, String(req.params.id), req.body ?? {}))));
  r.delete("/workflows/:id", h(async (req, res) => {
    await s.workflows.remove(req.auth!, String(req.params.id));
    res.status(204).end();
  }));
  r.post("/workflows/:id/activate", h(async (req, res) => res.json(await s.workflows.activate(req.auth!, String(req.params.id), req))));
  r.post("/workflows/:id/pause", h(async (req, res) => res.json(await s.workflows.pause(req.auth!, String(req.params.id)))));
  r.post("/workflows/:id/run", h(async (req, res) => {
    const triggerData = req.body?.triggerData && typeof req.body.triggerData === "object" ? (req.body.triggerData as Record<string, unknown>) : undefined;
    res.status(202).json(await s.workflows.run(req.auth!, String(req.params.id), triggerData, req.body?.wait === true));
  }));
  r.get("/workflows/:id/executions", h(async (req, res) => res.json(await s.workflows.executions(req.auth!, String(req.params.id)))));
  r.get("/executions/:id", h(async (req, res) => res.json(await s.workflows.execution(req.auth!, String(req.params.id)))));

  // ── Webhook events (operations) ────────────────────────────────────────────
  r.get("/webhook-events", h(async (req, res) => res.json(await s.webhooks.list(req.auth!))));
  r.post("/webhook-events/:id/replay", manage, h(async (req, res) => res.json(await s.webhooks.replay(req.auth!, String(req.params.id), req))));

  return r;
}

/**
 * Public webhook receivers: POST /webhooks/:provider[/:endpointToken].
 * Raw body is kept for signature verification. No cookies, no CORS, no session.
 */
export function webhooksRouter(s: Services, opts: { rateLimitMax?: number } = {}) {
  const r = Router();
  r.use(express.raw({ type: () => true, limit: "1mb" }));
  r.use(
    rateLimit({
      windowMs: 60_000,
      limit: opts.rateLimitMax ?? 1200,
      standardHeaders: "draft-8",
      legacyHeaders: false,
      keyGenerator: (req) => `${req.params.provider ?? ""}:${ipKeyGenerator(req.ip ?? "unknown")}`,
    }),
  );
  const toRaw = (req: Request): RawWebhookRequest => {
    const headers: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(req.headers)) headers[k.toLowerCase()] = Array.isArray(v) ? v.join(",") : v;
    return {
      headers,
      rawBody: Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0),
      method: req.method,
      url: `${env.PUBLIC_API_URL}${req.originalUrl}`,
      params: req.params as Record<string, string>,
      query: Object.fromEntries(Object.entries(req.query).filter(([, v]) => typeof v === "string")) as Record<string, string>,
    };
  };
  r.post("/shopify/compliance", h(async (req, res) => {
    const result = await s.webhooks.shopifyCompliance(toRaw(req));
    res.status(result.status).json(result.body);
  }));
  const receive = h(async (req, res) => {
    const raw = toRaw(req);
    const result = await s.webhooks.ingest(String(req.params.provider), req.params.endpointToken ? String(req.params.endpointToken) : undefined, raw);
    res.status(result.status).json(result.body);
  });
  r.post("/:provider", receive);
  r.post("/:provider/:endpointToken", receive);
  return r;
}
