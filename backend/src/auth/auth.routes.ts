import { Router } from "express";
import { rateLimit } from "express-rate-limit";
import type { AuditService } from "../audit/audit.service.js";
import type { Db } from "../db/client.js";
import { AppError, Errors } from "../lib/errors.js";
import { AuthService, loginSchema, parseOrThrow, registerSchema, toPublicUser } from "./auth.service.js";
import { requireAuth } from "./middleware.js";
import { csrfTokenFor, type SessionService } from "./session.service.js";

/**
 * /v1/auth
 *   POST /register  → 201 { user, workspace, csrfToken } + session cookie
 *   POST /login     → 200 { user, workspace, csrfToken } + session cookie
 *   POST /logout    → 204 (requires session + CSRF)
 *   GET  /me        → 200 { user, workspace, role, csrfToken }
 */
export function authRouter(deps: { db: Db; sessions: SessionService; audit: AuditService; rateLimitMax?: number }) {
  const { db, sessions, audit } = deps;
  const auth = new AuthService(db);
  const router = Router();

  // Brute-force protection: per IP + email for login, per IP for register.
  const limiter = (keyFn: (req: import("express").Request) => string) =>
    rateLimit({
      windowMs: 15 * 60 * 1000,
      limit: deps.rateLimitMax ?? 10,
      standardHeaders: "draft-8",
      legacyHeaders: false,
      keyGenerator: keyFn,
      handler: (_req, _res, next) => next(Errors.rateLimited()),
    });
  const loginLimiter = limiter((req) => `${req.ip}:${String(req.body?.email ?? "").toLowerCase()}`);
  const registerLimiter = limiter((req) => `register:${req.ip}`);

  router.post("/register", registerLimiter, async (req, res, next) => {
    try {
      const input = parseOrThrow(registerSchema, req.body);
      const { user, workspace } = await auth.register(input);
      const { token } = await sessions.create({ userId: user.id, workspaceId: workspace.id, ip: req.ip, userAgent: req.get("user-agent") });
      sessions.setCookie(res, token);
      await audit.record({ action: "auth.registered", actorUserId: user.id, workspaceId: workspace.id, targetType: "user", targetId: user.id }, req);
      res.status(201).json({
        user: toPublicUser(user),
        workspace: { id: workspace.id, name: workspace.name, slug: workspace.slug },
        role: "OWNER",
        csrfToken: csrfTokenFor(token),
      });
    } catch (err) {
      next(err);
    }
  });

  router.post("/login", loginLimiter, async (req, res, next) => {
    try {
      const input = parseOrThrow(loginSchema, req.body);
      try {
        const { user, workspace } = await auth.login(input);
        const { token } = await sessions.create({ userId: user.id, workspaceId: workspace.id, ip: req.ip, userAgent: req.get("user-agent") });
        sessions.setCookie(res, token);
        await audit.record({ action: "auth.login.success", actorUserId: user.id, workspaceId: workspace.id }, req);
        res.json({
          user: toPublicUser(user),
          workspace: { id: workspace.id, name: workspace.name, slug: workspace.slug },
          csrfToken: csrfTokenFor(token),
        });
      } catch (err) {
        if (err instanceof AppError && err.code === "auth.invalid_credentials") {
          // The attempted email is not stored, only that a failure happened from this IP.
          await audit.record({ action: "auth.login.failed" }, req);
        }
        throw err;
      }
    } catch (err) {
      next(err);
    }
  });

  router.post("/logout", requireAuth, async (req, res, next) => {
    try {
      await sessions.revoke(req.auth!.sessionId);
      sessions.clearCookie(res);
      await audit.record({ action: "auth.logout", actorUserId: req.auth!.userId, workspaceId: req.auth!.workspaceId }, req);
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  router.get("/me", requireAuth, async (req, res, next) => {
    try {
      const ctx = req.auth!;
      const [user, workspace] = await Promise.all([
        db.user.findUniqueOrThrow({ where: { id: ctx.userId } }),
        db.workspace.findUniqueOrThrow({ where: { id: ctx.workspaceId } }),
      ]);
      res.set("Cache-Control", "no-store").json({
        user: toPublicUser(user),
        workspace: { id: workspace.id, name: workspace.name, slug: workspace.slug },
        role: ctx.role,
        csrfToken: csrfTokenFor(ctx.token),
      });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
