import { createHash, randomBytes } from "node:crypto";
import type { Request } from "express";
import type { Db } from "../../db/client.js";
import type { CredentialCipher } from "../../security/crypto.js";
import { randomToken, sha256 } from "../../security/crypto.js";
import { env, webhookBaseUrl } from "../../config/env.js";
import type { AuthContext } from "../../auth/session.service.js";
import type { AuditService } from "../../audit/audit.service.js";
import { AppError } from "../../lib/errors.js";
import { getConnector, isConfigured } from "../core/registry.js";
import { CredentialService } from "../connections/credential.service.js";
import { getOAuthProvider } from "./providers.js";
import { OAuthError } from "./types.js";

export const STATE_TTL_MS = 10 * 60 * 1000;

/**
 * OAuth redirect URI. Normally PUBLIC_API_URL. When the API runs on http (local development) and the
 * provider only accepts https redirects, the public HTTPS webhook origin (tunnel) is used instead; the
 * local webhook gateway answers that callback with a 302 back to the local API, where the session
 * cookie and the single-use state are checked as usual.
 */
export const redirectUriFor = (providerId: string) => {
  const base = getOAuthProvider(providerId)?.httpsRedirectOnly && !env.PUBLIC_API_URL.startsWith("https://") && webhookBaseUrl().startsWith("https://") ? webhookBaseUrl() : env.PUBLIC_API_URL;
  return `${base}/v1/oauth/${providerId}/callback`;
};

function pkcePair() {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

/** Only same-app relative paths may be used as post-connect redirects (no open redirects). */
export function safeRedirectPath(path: unknown): string {
  const p = typeof path === "string" ? path : "";
  return /^\/(?!\/)[A-Za-z0-9/_\-?=&.%]*$/.test(p) && !p.includes("\\") ? p : "/dashboard/integrations";
}

interface StatePayload {
  verifier?: string;
  extra: Record<string, string>;
}

export class OAuthService {
  constructor(
    private readonly db: Db,
    private readonly cipher: CredentialCipher,
    private readonly credentials: CredentialService,
    private readonly audit: AuditService,
  ) {}

  /** Starts the authorization-code flow. Returns the provider consent URL. */
  async start(ctx: AuthContext, connectorId: string, input: { redirectPath?: string; connectionId?: string; [k: string]: unknown }) {
    const def = getConnector(connectorId);
    if (!def || def.auth.type !== "oauth2") throw new AppError(404, "integrations.unknown_connector");
    const provider = getOAuthProvider(def.auth.provider);
    if (!provider) throw new AppError(404, "integrations.unknown_connector");
    if (!isConfigured(def)) throw new AppError(400, "integrations.not_configured");

    if (input.connectionId) {
      const existing = await this.db.connection.findFirst({ where: { id: String(input.connectionId), workspaceId: ctx.workspaceId, provider: connectorId } });
      if (!existing) throw new AppError(404, "not_found");
    }

    let extra: Record<string, string> = {};
    try {
      extra = provider.startParams?.(input) ?? {};
    } catch (err) {
      if (err instanceof OAuthError) throw new AppError(400, err.code);
      throw err;
    }

    const state = randomToken(32);
    const stateHash = sha256(state);
    const pkce = provider.pkce ? pkcePair() : undefined;
    const payload: StatePayload = { verifier: pkce?.verifier, extra };

    await this.db.oAuthState.create({
      data: {
        stateHash,
        provider: connectorId,
        userId: ctx.userId,
        workspaceId: ctx.workspaceId,
        sessionId: ctx.sessionId,
        connectionId: input.connectionId ? String(input.connectionId) : null,
        codeVerifier: this.cipher.encryptJson(payload, `oauth-state:${stateHash}`),
        redirectPath: safeRedirectPath(input.redirectPath),
        expiresAt: new Date(Date.now() + STATE_TTL_MS),
      },
    });

    return provider.authorizeUrl({
      clientId: provider.clientId(),
      redirectUri: redirectUriFor(provider.id),
      state,
      scopes: def.auth.scopes,
      codeChallenge: pkce?.challenge,
      extra,
    });
  }

  /**
   * Handles the provider redirect. Always resolves to a URL in the web app; errors are reported
   * as ?status=error&reason=<code> so the UI can show a localized message.
   */
  async callback(providerId: string, query: Record<string, string>, ctx: AuthContext | undefined, req?: Request): Promise<string> {
    const appUrl = (path: string, params: Record<string, string>) => {
      const u = new URL(path, env.APP_URL);
      for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
      return u.toString();
    };
    let redirectPath = "/dashboard/integrations";
    try {
      if (!query.state) throw new OAuthError("oauth.invalid_state");
      const stateHash = sha256(query.state);
      const state = await this.db.oAuthState.findUnique({ where: { stateHash } });
      if (!state) throw new OAuthError("oauth.invalid_state");
      redirectPath = state.redirectPath;
      if (state.usedAt) throw new OAuthError("oauth.invalid_state", "State already used");
      if (state.expiresAt <= new Date()) throw new OAuthError("oauth.state_expired");
      // The flow must finish in the same browser session that started it (login CSRF protection).
      if (!ctx || ctx.sessionId !== state.sessionId || ctx.workspaceId !== state.workspaceId) throw new OAuthError("oauth.session_mismatch");

      // Single use, also under concurrent replays.
      const claimed = await this.db.oAuthState.updateMany({ where: { id: state.id, usedAt: null }, data: { usedAt: new Date() } });
      if (claimed.count !== 1) throw new OAuthError("oauth.invalid_state", "State already used");

      const def = getConnector(state.provider);
      if (!def || def.auth.type !== "oauth2" || def.auth.provider !== providerId) throw new OAuthError("oauth.invalid_state", "Provider mismatch");
      const provider = getOAuthProvider(providerId)!;

      if (query.error) throw new OAuthError("oauth.denied", query.error);
      if (!query.code) throw new OAuthError("oauth.invalid_request", "Missing code");

      const payload = this.cipher.decryptJson<StatePayload>(state.codeVerifier!, `oauth-state:${stateHash}`);
      provider.verifyCallback?.(query, payload.extra);

      const tokens = await provider.exchange({ code: query.code, redirectUri: redirectUriFor(providerId), codeVerifier: payload.verifier, extra: payload.extra });
      const identity = await provider.identify(tokens);

      // Least privilege is requested; if the user unticked a required scope, fail clearly.
      if (tokens.scopes.length > 0) {
        const missing = def.auth.scopes.filter((s) => !tokens.scopes.includes(s));
        if (missing.length) throw new OAuthError("oauth.scopes_missing", missing.join(" "));
      }

      const connection = await this.db.$transaction(async (tx) => {
        let conn = state.connectionId
          ? await tx.connection.findFirst({ where: { id: state.connectionId, workspaceId: state.workspaceId } })
          : await tx.connection.findFirst({ where: { workspaceId: state.workspaceId, provider: state.provider, externalAccountId: identity.externalAccountId } });
        if (conn && conn.externalAccountId && conn.externalAccountId !== identity.externalAccountId) throw new OAuthError("oauth.account_mismatch");

        const data = {
          displayName: identity.displayName,
          externalAccountId: identity.externalAccountId,
          scopes: tokens.scopes.length ? tokens.scopes : def.auth.type === "oauth2" ? def.auth.scopes : [],
          status: "ACTIVE" as const,
          lastError: null,
        };
        conn = conn
          ? await tx.connection.update({ where: { id: conn.id }, data })
          : await tx.connection.create({ data: { ...data, workspaceId: state.workspaceId, provider: state.provider, authType: "OAUTH2", createdById: state.userId } });
        await this.credentials.save(tx, conn, CredentialService.fromTokens(tokens), tokens.expiresAt ?? null);
        return conn;
      });

      await this.audit.record(
        {
          action: state.connectionId ? "connection.refreshed" : "connection.created",
          workspaceId: state.workspaceId,
          actorUserId: state.userId,
          targetType: "connection",
          targetId: connection.id,
          metadata: { provider: state.provider, scopes: connection.scopes, reauthorized: !!state.connectionId },
        },
        req,
      );
      return appUrl(redirectPath, { status: "connected", connection: connection.id });
    } catch (err) {
      const reason = err instanceof OAuthError ? err.code : "oauth.exchange_failed";
      return appUrl(redirectPath, { status: "error", reason });
    }
  }

  /** Removes expired state rows (scheduled maintenance). */
  async purgeExpired() {
    await this.db.oAuthState.deleteMany({ where: { expiresAt: { lt: new Date(Date.now() - 24 * 60 * 60 * 1000) } } });
  }
}
