import type { Db } from "../../db/client.js";
import { env } from "../../config/env.js";
import { logger } from "../../lib/logger.js";
import { forWorkspace } from "../../tenancy/scoped-db.js";
import type { CredentialService } from "../connections/credential.service.js";
import { ConnectorError } from "./errors.js";
import { HttpClient } from "./http.js";
import { getConnector } from "./registry.js";
import type { ConnectorContext, ConnectorDefinition, Credentials } from "./types.js";

export interface ExecuteActionInput {
  workspaceId: string;
  connectorId: string;
  actionKey: string;
  connectionId?: string | null;
  input: unknown;
  idempotencyKey?: string;
}

/**
 * Runs connector actions and builds connector contexts.
 * Every call re-checks that the connection belongs to the workspace (tenant isolation),
 * is active, and injects freshly decrypted (and if needed refreshed) credentials.
 * Credentials never leave this process and are never logged.
 */
export class ConnectorRuntime {
  constructor(
    private readonly db: Db,
    private readonly credentials: CredentialService,
  ) {}

  connector(id: string): ConnectorDefinition {
    const def = getConnector(id);
    if (!def) throw new ConnectorError("NOT_SUPPORTED", `Unknown connector: ${id}`);
    return def;
  }

  async context(workspaceId: string, def: ConnectorDefinition, connectionId: string | null | undefined, opts: { idempotencyKey?: string; forceRefresh?: boolean } = {}): Promise<ConnectorContext> {
    const http = (key: string) => new HttpClient({ provider: def.id, breakerKey: key, mapError: def.mapError, isErrorBody: def.isErrorBody });
    if (def.auth.type === "none") {
      return { credentials: {}, connection: { id: "none", workspaceId, externalAccountId: null }, http: http(`${def.id}:${workspaceId}`), idempotencyKey: opts.idempotencyKey, publicApiUrl: env.PUBLIC_API_URL };
    }
    if (!connectionId) throw new ConnectorError("VALIDATION", "A connection is required for this step");
    const conn = await forWorkspace(this.db, workspaceId).connection.findUnique({ where: { id: connectionId } });
    if (!conn || conn.provider !== def.id) throw new ConnectorError("NOT_FOUND", "Connection not found");
    if (conn.status === "REVOKED") throw new ConnectorError("AUTH_REVOKED", "Connection was disconnected");
    if (conn.status === "EXPIRED") throw new ConnectorError("AUTH_EXPIRED", "Connection needs to be reauthorized");
    const creds: Credentials = await this.credentials.getValid(conn, { force: opts.forceRefresh });
    return {
      credentials: creds,
      connection: { id: conn.id, workspaceId, externalAccountId: conn.externalAccountId },
      http: http(`${def.id}:${conn.id}`),
      idempotencyKey: opts.idempotencyKey,
      publicApiUrl: env.PUBLIC_API_URL,
    };
  }

  async executeAction(req: ExecuteActionInput): Promise<unknown> {
    const def = this.connector(req.connectorId);
    const action = def.actions[req.actionKey];
    if (!action) throw new ConnectorError("NOT_SUPPORTED", `Unknown action: ${req.connectorId}.${req.actionKey}`);
    const parsed = action.input.safeParse(req.input ?? {});
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ");
      throw new ConnectorError("VALIDATION", issues, { provider: def.id });
    }

    const run = async (forceRefresh: boolean) => {
      const ctx = await this.context(req.workspaceId, def, req.connectionId, { idempotencyKey: req.idempotencyKey, forceRefresh });
      return action.run(ctx, parsed.data);
    };

    const started = Date.now();
    try {
      let result: unknown;
      try {
        result = await run(false);
      } catch (err) {
        // A 401 on a token we believed valid: refresh once and retry (OAuth connectors only).
        if (err instanceof ConnectorError && err.code === "AUTH_EXPIRED" && def.auth.type === "oauth2" && req.connectionId) {
          result = await run(true);
        } else throw err;
      }
      logger.info({ connector: def.id, action: action.key, durationMs: Date.now() - started }, "connector action succeeded");
      return result;
    } catch (err) {
      const e = err instanceof ConnectorError ? err : new ConnectorError("UNKNOWN", err instanceof Error ? err.message : "Unknown error", { provider: def.id });
      logger.warn({ connector: def.id, action: action.key, code: e.code, durationMs: Date.now() - started }, "connector action failed");
      if (req.connectionId && (e.code === "AUTH_REVOKED" || e.code === "AUTH_EXPIRED")) {
        await this.db.connection.updateMany({
          where: { id: req.connectionId, workspaceId: req.workspaceId, status: "ACTIVE" },
          data: { status: e.code === "AUTH_REVOKED" ? "REVOKED" : "EXPIRED", lastError: e.message },
        });
      }
      throw e;
    }
  }
}
