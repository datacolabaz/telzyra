import type { CookieOptions, Response } from "express";
import type { Db } from "../db/client.js";
import { env, isProduction } from "../config/env.js";
import { hmacSha256, randomToken, sha256 } from "../security/crypto.js";

export const SESSION_COOKIE = "tz_session";
const TOUCH_INTERVAL_MS = 5 * 60 * 1000;

export interface AuthContext {
  sessionId: string;
  userId: string;
  workspaceId: string;
  role: "OWNER" | "ADMIN" | "MEMBER";
  /** Raw session token, kept in memory only for this request (needed to derive the CSRF token). */
  token: string;
}

/**
 * CSRF token derived from the session token (HMAC). It cannot be computed without the
 * HttpOnly cookie, needs no storage, and changes whenever the session changes.
 */
export function csrfTokenFor(sessionToken: string): string {
  return hmacSha256(sessionToken, "telzyra-csrf-v1");
}

export function cookieOptions(): CookieOptions {
  return {
    httpOnly: true,
    secure: isProduction,
    sameSite: "lax",
    path: "/",
    domain: env.COOKIE_DOMAIN || undefined,
    maxAge: env.SESSION_TTL_DAYS * 24 * 60 * 60 * 1000,
  };
}

export class SessionService {
  constructor(private readonly db: Db) {}

  async create(params: { userId: string; workspaceId: string; ip?: string; userAgent?: string }) {
    const token = randomToken(32);
    const session = await this.db.session.create({
      data: {
        tokenHash: sha256(token),
        userId: params.userId,
        workspaceId: params.workspaceId,
        ip: params.ip ?? null,
        userAgent: params.userAgent?.slice(0, 300) ?? null,
        expiresAt: new Date(Date.now() + env.SESSION_TTL_DAYS * 24 * 60 * 60 * 1000),
      },
    });
    return { token, session };
  }

  /** Resolves a cookie token to an auth context, or null if missing/expired/revoked. */
  async resolve(token: string | undefined): Promise<AuthContext | null> {
    if (!token || token.length < 20 || token.length > 100) return null;
    const session = await this.db.session.findUnique({ where: { tokenHash: sha256(token) } });
    if (!session || session.revokedAt || session.expiresAt <= new Date()) return null;

    const membership = await this.db.membership.findUnique({
      where: { userId_workspaceId: { userId: session.userId, workspaceId: session.workspaceId } },
    });
    if (!membership) return null; // removed from the workspace: the session no longer grants access

    if (Date.now() - session.lastSeenAt.getTime() > TOUCH_INTERVAL_MS) {
      await this.db.session.update({ where: { id: session.id }, data: { lastSeenAt: new Date() } });
    }
    return {
      sessionId: session.id,
      userId: session.userId,
      workspaceId: session.workspaceId,
      role: membership.role,
      token,
    };
  }

  async revoke(sessionId: string): Promise<void> {
    await this.db.session.updateMany({
      where: { id: sessionId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  setCookie(res: Response, token: string) {
    res.cookie(SESSION_COOKIE, token, cookieOptions());
  }

  clearCookie(res: Response) {
    const { maxAge: _maxAge, ...opts } = cookieOptions();
    res.clearCookie(SESSION_COOKIE, opts);
  }
}
