import type { NextFunction, Request, Response } from "express";
import { env } from "../config/env.js";
import { Errors } from "../lib/errors.js";
import { safeEqual } from "../security/crypto.js";
import { csrfTokenFor, SESSION_COOKIE, type AuthContext, type SessionService } from "./session.service.js";

declare module "express-serve-static-core" {
  interface Request {
    auth?: AuthContext;
  }
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Origin check for state-changing requests. Browsers always send Origin on cross-origin
 * POST/PUT/PATCH/DELETE; a request whose Origin is not ours is rejected. Requests without
 * an Origin header are not browser-initiated (server-to-server), so CSRF does not apply.
 */
export function originGuard(req: Request, _res: Response, next: NextFunction) {
  if (SAFE_METHODS.has(req.method)) return next();
  const origin = req.get("origin");
  if (origin && !env.CORS_ORIGINS.includes(origin)) return next(Errors.csrf());
  next();
}

/** Attaches req.auth when a valid session cookie is present. Never fails the request. */
export function loadSession(sessions: SessionService) {
  return async (req: Request, _res: Response, next: NextFunction) => {
    try {
      const ctx = await sessions.resolve(req.cookies?.[SESSION_COOKIE]);
      if (ctx) req.auth = ctx;
      next();
    } catch (err) {
      next(err);
    }
  };
}

/** Requires an authenticated session; for state-changing methods also a valid CSRF token. */
export function requireAuth(req: Request, _res: Response, next: NextFunction) {
  if (!req.auth) return next(Errors.unauthorized());
  if (!SAFE_METHODS.has(req.method)) {
    const header = req.get("x-csrf-token") ?? "";
    if (!header || !safeEqual(header, csrfTokenFor(req.auth.token))) return next(Errors.csrf());
  }
  next();
}

export function requireRole(...roles: AuthContext["role"][]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.auth) return next(Errors.unauthorized());
    if (!roles.includes(req.auth.role)) return next(Errors.forbidden());
    next();
  };
}
