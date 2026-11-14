import type { Request } from "express";
import type { Db } from "../../db/client.js";
import type { AuditService } from "../../audit/audit.service.js";
import type { AuthContext } from "../../auth/session.service.js";
import { AppError } from "../../lib/errors.js";
import { logger } from "../../lib/logger.js";
import { forWorkspace } from "../../tenancy/scoped-db.js";
import { env } from "../../config/env.js";
import { ConnectorError } from "../core/errors.js";
import { HttpClient } from "../core/http.js";
import { getConnector } from "../core/registry.js";
import type { ConnectorRuntime } from "../core/runtime.js";
import { getOAuthProvider } from "../oauth/providers.js";
import type { CredentialService } from "./credential.service.js";

/** Public, secret-free view of a connection. */
export function publicConnection(c: {
  id: string;
  provider: string;
  authType: string;
  displayName: string;
  externalAccountId: string | null;
  status: string;
  scopes: string[];
  health: unknown;
  lastCheckedAt: Date | null;
  lastError: string | null;
  createdAt: Date;
}) {
  return {
    id: c.id,
    provider: c.provider,
    authType: c.authType,
    displayName: c.displayName,
    accountId: c.externalAccountId,
    status: c.status,
    scopes: c.scopes,
    health: c.health,
    lastCheckedAt: c.lastCheckedAt,
    lastError: c.lastError,
    createdAt: c.createdAt,
  };
}

export class ConnectionService {
  constructor(
    private readonly db: Db,
    private readonly credentials: CredentialService,
    private readonly runtime: ConnectorRuntime,
    private readonly audit: AuditService,
  ) {}

  async list(workspaceId: string) {
    const scoped = forWorkspace(this.db, workspaceId);
    const [connections, workflows] = await Promise.all([
      scoped.connection.findMany({ orderBy: { createdAt: "desc" } }),
      scoped.workflow.findMany({ select: { id: true, name: true, status: true, definition: true } }),
    ]);
    return connections.map((c) => ({
      ...publicConnection(c),
      usedBy: workflows.filter((w) => usesConnection(w.definition, c.id)).map((w) => ({ id: w.id, name: w.name, status: w.status })),
    }));
  }

  /** Bot-token / API-key connections: validate against the provider before storing anything. */
  async createWithSecret(ctx: AuthContext, connectorId: string, secret: string, req?: Request) {
    const def = getConnector(connectorId);
    if (!def || (def.auth.type !== "bot_token" && def.auth.type !== "api_key")) throw new AppError(400, "integrations.unknown_connector");
    const creds = def.auth.type === "bot_token" ? { botToken: secret } : { apiKey: secret };
    const tempCtx = {
      credentials: creds,
      connection: { id: "pending", workspaceId: ctx.workspaceId, externalAccountId: null },
      http: new HttpClient({ provider: def.id, breakerKey: `${def.id}:pending:${ctx.workspaceId}`, mapError: def.mapError, isErrorBody: def.isErrorBody }),
      publicApiUrl: env.PUBLIC_API_URL,
    };
    let identity: { accountId?: string; accountName: string };
    try {
      identity = await def.test(tempCtx);
    } catch (err) {
      const code = err instanceof ConnectorError ? err.code : "UNKNOWN";
      throw new AppError(400, "connection.invalid_credentials", { providerCode: code });
    }

    const authType = def.auth.type === "bot_token" ? "BOT_TOKEN" : "API_KEY";
    const conn = await this.db.$transaction(async (tx) => {
      const existing = identity.accountId
        ? await tx.connection.findFirst({ where: { workspaceId: ctx.workspaceId, provider: connectorId, externalAccountId: identity.accountId } })
        : null;
      const data = { displayName: identity.accountName, status: "ACTIVE" as const, lastError: null, lastCheckedAt: new Date(), health: { ok: true, checkedAt: new Date().toISOString() } };
      const c = existing
        ? await tx.connection.update({ where: { id: existing.id }, data })
        : await tx.connection.create({
            data: { ...data, workspaceId: ctx.workspaceId, provider: connectorId, authType, externalAccountId: identity.accountId ?? null, scopes: [], createdById: ctx.userId },
          });
      await this.credentials.save(tx, c, creds);
      return c;
    });
    await this.audit.record({ action: "connection.created", workspaceId: ctx.workspaceId, actorUserId: ctx.userId, targetType: "connection", targetId: conn.id, metadata: { provider: connectorId } }, req);
    return publicConnection(conn);
  }

  async get(workspaceId: string, id: string) {
    const c = await forWorkspace(this.db, workspaceId).connection.findUnique({ where: { id } });
    if (!c) throw new AppError(404, "not_found");
    return c;
  }

  /** Calls the provider with the stored credentials and records the result as connection health. */
  async test(ctx: AuthContext, id: string, req?: Request) {
    const c = await this.get(ctx.workspaceId, id);
    const def = getConnector(c.provider);
    if (!def) throw new AppError(400, "integrations.unknown_connector");
    const started = Date.now();
    let health: { ok: boolean; latencyMs: number; checkedAt: string; error?: string; code?: string };
    try {
      const cctx = await this.runtime.context(ctx.workspaceId, def, c.id);
      await def.test(cctx);
      health = { ok: true, latencyMs: Date.now() - started, checkedAt: new Date().toISOString() };
    } catch (err) {
      const e = err instanceof ConnectorError ? err : new ConnectorError("UNKNOWN", "Connection test failed");
      health = { ok: false, latencyMs: Date.now() - started, checkedAt: new Date().toISOString(), code: e.code, error: e.message };
    }
    const statusUpdate =
      health.ok ? { status: "ACTIVE" as const, lastError: null } : health.code === "AUTH_EXPIRED" ? { status: "EXPIRED" as const, lastError: health.error } : health.code === "AUTH_REVOKED" ? { status: "REVOKED" as const, lastError: health.error } : { lastError: health.error };
    const updated = await this.db.connection.update({ where: { id: c.id }, data: { health, lastCheckedAt: new Date(), ...statusUpdate } });
    await this.audit.record({ action: "connection.tested", workspaceId: ctx.workspaceId, actorUserId: ctx.userId, targetType: "connection", targetId: c.id, metadata: { ok: health.ok, code: health.code } }, req);
    return publicConnection(updated);
  }

  /**
   * Disconnect: unsubscribes provider webhooks, revokes tokens at the provider (best effort),
   * deletes the stored credentials and marks the connection REVOKED. Workflows using it are paused.
   */
  async disconnect(ctx: AuthContext, id: string, req?: Request) {
    const c = await this.get(ctx.workspaceId, id);
    const def = getConnector(c.provider);
    if (def) {
      try {
        const cctx = await this.runtime.context(ctx.workspaceId, def, c.id);
        const subs = await this.db.webhookSubscription.findMany({ where: { connectionId: c.id, workspaceId: ctx.workspaceId } });
        for (const s of subs) await def.webhook?.unsubscribe?.(cctx, s.externalId).catch(() => undefined);
        if (def.auth.type === "oauth2") {
          await getOAuthProvider(def.auth.provider)?.revoke?.({ accessToken: cctx.credentials.accessToken, refreshToken: cctx.credentials.refreshToken as string | undefined }, cctx.credentials).catch((err) => {
            logger.warn({ provider: c.provider, err: err instanceof Error ? err.message : String(err) }, "provider token revocation failed");
          });
        }
      } catch {
        /* credentials may already be invalid; local cleanup still proceeds */
      }
    }
    await this.db.$transaction(async (tx) => {
      await tx.webhookSubscription.deleteMany({ where: { connectionId: c.id, workspaceId: ctx.workspaceId } });
      await tx.credential.deleteMany({ where: { connectionId: c.id } });
      await tx.connection.update({ where: { id: c.id }, data: { status: "REVOKED", lastError: null } });
      const scoped = await tx.workflow.findMany({ where: { workspaceId: ctx.workspaceId, status: "ACTIVE" } });
      for (const w of scoped.filter((w) => usesConnection(w.definition, c.id))) {
        await tx.workflow.update({ where: { id: w.id }, data: { status: "PAUSED" } });
      }
    });
    await this.audit.record({ action: "connection.revoked", workspaceId: ctx.workspaceId, actorUserId: ctx.userId, targetType: "connection", targetId: c.id, metadata: { provider: c.provider } }, req);
  }

  /** Permanently removes a connection. Refused while workflows still reference it. */
  async remove(ctx: AuthContext, id: string, req?: Request) {
    const c = await this.get(ctx.workspaceId, id);
    const workflows = await forWorkspace(this.db, ctx.workspaceId).workflow.findMany({ select: { id: true, definition: true } });
    if (workflows.some((w) => usesConnection(w.definition, c.id))) throw new AppError(409, "connection.in_use");
    if (c.status !== "REVOKED") await this.disconnect(ctx, id, req);
    await forWorkspace(this.db, ctx.workspaceId).connection.delete({ where: { id: c.id } });
    await this.audit.record({ action: "connection.deleted", workspaceId: ctx.workspaceId, actorUserId: ctx.userId, targetType: "connection", targetId: c.id }, req);
  }
}

export function usesConnection(definition: unknown, connectionId: string): boolean {
  const d = definition as { trigger?: { connectionId?: string }; steps?: Array<{ connectionId?: string }> } | null;
  return d?.trigger?.connectionId === connectionId || (d?.steps ?? []).some((s) => s.connectionId === connectionId);
}
