import { Router } from "express";
import { ipKeyGenerator, rateLimit } from "express-rate-limit";
import type { AuditService } from "../audit/audit.service.js";
import type { Db } from "../db/client.js";
import { AppError, Errors } from "../lib/errors.js";
import { AuthService, loginSchema, parseOrThrow, registerSchema, toPublicUser } from "./auth.service.js";
import { requireAuth } from "./middleware.js";
import { csrfTokenFor, cookieOptions, type SessionService } from "./session.service.js";
import { env } from "../config/env.js";
import type { CredentialCipher } from "../security/crypto.js";
import { GOOGLE_LOGIN_COOKIE, GoogleLoginError, GoogleLoginService, googleLoginEnabled, toLocale } from "./google-login.js";

/**
 * /v1/auth
 *   POST /register  → 201 { user, workspace, csrfToken } + session cookie
 *   POST /login     → 200 { user, workspace, csrfToken } + session cookie
 *   POST /logout    → 204 (requires session + CSRF)
 *   GET  /me        → 200 { user, workspace, role, csrfToken }
 *   GET  /providers → 200 { google: boolean }  (which sign-in buttons to show)
 *   GET  /google/start, /google/callback → "Continue with Google" (see google-login.ts)
 */
export function authRouter(deps: { db: Db; sessions: SessionService; audit: AuditService; cipher: CredentialCipher; rateLimitMax?: number; google?: GoogleLoginService }) {
  const { db, sessions, audit } = deps;
  const google = deps.google ?? new GoogleLoginService(db, deps.cipher);
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
  // ipKeyGenerator groups IPv6 addresses by /56 subnet, so rotating addresses inside one
  // allocation does not bypass the limit.
  const ip = (req: import("express").Request) => ipKeyGenerator(req.ip ?? "unknown");
  const loginLimiter = limiter((req) => `${ip(req)}:${String(req.body?.email ?? "").toLowerCase()}`);
  const registerLimiter = limiter((req) => `register:${ip(req)}`);

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

  router.get("/providers", (_req, res) => {
    res.set("Cache-Control", "no-store").json({ google: googleLoginEnabled() });
  });

  // ── Continue with Google ────────────────────────────────────────────────────
  // Top-level browser navigations (no CSRF header possible). The flow is bound to the browser by an
  // encrypted, short-lived, HttpOnly state cookie; errors go back to the login page as ?error=google_<code>.
  const appUrl = (path: string, params: Record<string, string> = {}) => {
    const u = new URL(path, env.APP_URL);
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    return u.toString();
  };
  const loginPath = (locale: string) => (locale === "en" ? "/login" : `/${locale}/login`);
  const dashboardPath = (locale: string) => (locale === "en" ? "/dashboard" : `/${locale}/dashboard`);
  const stateCookie = () => ({ ...cookieOptions(), maxAge: 10 * 60 * 1000 });
  const googleLimiter = limiter((req) => `google:${ip(req)}`);

  router.get("/google/start", googleLimiter, (req, res) => {
    const locale = toLocale(req.query.locale); // whitelisted: it ends up in a redirect URL
    try {
      const { url, cookie } = google.start(locale);
      res.cookie(GOOGLE_LOGIN_COOKIE, cookie, stateCookie());
      res.set("Cache-Control", "no-store").redirect(302, url);
    } catch {
      res.redirect(303, appUrl(loginPath(locale), { error: "google_unavailable" }));
    }
  });

  router.get("/google/callback", googleLimiter, async (req, res) => {
    const query = Object.fromEntries(Object.entries(req.query).filter(([, v]) => typeof v === "string")) as Record<string, string>;
    const cookie = req.cookies?.[GOOGLE_LOGIN_COOKIE] as string | undefined;
    res.clearCookie(GOOGLE_LOGIN_COOKIE, { ...cookieOptions(), maxAge: undefined });
    let locale: string = "en";
    try {
      const verified = await google.verifyCallback(query, cookie);
      locale = verified.locale;
      const { user, workspace, created, linked } = await google.resolveAccount(verified.profile, verified.locale);
      const { token } = await sessions.create({ userId: user.id, workspaceId: workspace.id, ip: req.ip, userAgent: req.get("user-agent") });
      sessions.setCookie(res, token);
      const action = created ? "auth.registered" : "auth.login.success";
      await audit.record({ action, actorUserId: user.id, workspaceId: workspace.id, metadata: { method: "google", linked } }, req);
      res.set("Cache-Control", "no-store").redirect(303, appUrl(dashboardPath(toLocale(user.locale || locale))));
    } catch (err) {
      const code = err instanceof GoogleLoginError ? err.code : "exchange_failed";
      if (err instanceof GoogleLoginError && err.locale) locale = err.locale;
      if (!(err instanceof GoogleLoginError)) req.log?.error({ err }, "google login failed");
      await audit.record({ action: "auth.login.failed", metadata: { method: "google", reason: code } }, req).catch(() => {});
      res.set("Cache-Control", "no-store").redirect(303, appUrl(loginPath(locale), { error: `google_${code}` }));
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
