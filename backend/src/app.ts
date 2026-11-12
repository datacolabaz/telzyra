import express, { type NextFunction, type Request, type Response } from "express";
import cookieParser from "cookie-parser";
import cors from "cors";
import helmet from "helmet";
import { pinoHttp } from "pino-http";
import { env } from "./config/env.js";
import { logger } from "./lib/logger.js";
import { AppError } from "./lib/errors.js";
import type { Db } from "./db/client.js";
import { AuditService } from "./audit/audit.service.js";
import { SessionService } from "./auth/session.service.js";
import { loadSession, originGuard } from "./auth/middleware.js";
import { authRouter } from "./auth/auth.routes.js";
import { PLANS } from "./plans.js";

export interface AppDeps {
  db: Db;
  /** Lower limits in tests. */
  rateLimitMax?: number;
}

export function createApp({ db, rateLimitMax }: AppDeps) {
  const app = express();
  const sessions = new SessionService(db);
  const audit = new AuditService(db);

  app.disable("x-powered-by");
  app.set("trust proxy", env.TRUST_PROXY);

  app.use(helmet());
  app.use(
    pinoHttp({
      logger,
      // Never log bodies; headers are redacted by the logger's redact list.
      autoLogging: { ignore: (req) => req.url === "/health" },
      customLogLevel: (_req, res, err) => (err || res.statusCode >= 500 ? "error" : res.statusCode >= 400 ? "warn" : "info"),
    }),
  );

  // Health is public and dependency-aware: Railway only routes traffic when the DB is reachable.
  app.get("/", (_req, res) => res.json({ name: "telzyra-api", status: "ok" }));
  app.get("/health", async (_req, res) => {
    try {
      await db.$queryRaw`SELECT 1`;
      res.json({ status: "ok", db: "ok", version: process.env.RAILWAY_GIT_COMMIT_SHA ?? "dev" });
    } catch {
      res.status(503).json({ status: "degraded", db: "unreachable" });
    }
  });

  // ── /v1: JSON API for the web app ─────────────────────────────────────────
  const v1 = express.Router();
  v1.use(cors({ origin: env.CORS_ORIGINS, credentials: true }));
  v1.use(express.json({ limit: "1mb" }));
  v1.use(cookieParser());
  v1.use(originGuard);
  v1.use(loadSession(sessions));

  v1.get("/plans", (_req, res) => {
    res.set("Cache-Control", "public, max-age=300").json(PLANS);
  });
  v1.use("/auth", authRouter({ db, sessions, audit, rateLimitMax }));

  app.use("/v1", v1);
  // Webhook receivers (raw body, signature verification) mount at /webhooks in a later module.

  app.use((_req, res) => res.status(404).json({ code: "not_found" }));

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof AppError) {
      return res.status(err.status).json({ code: err.code, ...(err.details ?? {}) });
    }
    if (err instanceof SyntaxError && "body" in err) {
      return res.status(400).json({ code: "invalid_json" });
    }
    req.log?.error({ err }, "unhandled error");
    res.status(500).json({ code: "unknown" });
  });

  return app;
}
