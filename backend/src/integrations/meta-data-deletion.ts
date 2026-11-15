import { createHmac, timingSafeEqual } from "node:crypto";
import type { AuditService } from "../audit/audit.service.js";
import { env } from "../config/env.js";
import type { Db } from "../db/client.js";
import { logger } from "../lib/logger.js";
import { randomToken, sha256 } from "../security/crypto.js";
import { usesConnection } from "./connections/connection.service.js";

/**
 * Meta "Data Deletion Request Callback"
 * https://developers.facebook.com/docs/development/create-an-app/app-dashboard/data-deletion-callback
 *
 * When a person removes Telzyra in their Facebook settings and asks for their data to be deleted,
 * Meta POSTs `signed_request` (form-encoded) to {PUBLIC_WEBHOOK_URL}/webhooks/meta/data-deletion.
 * We verify the HMAC-SHA256 signature with META_APP_SECRET, delete everything we hold from Meta for
 * that app-scoped user id (tokens, account ids, names; webhook subscriptions; workflows using the
 * connection are paused), and answer { url, confirmation_code } so the person can check the status
 * at {APP_URL}/data-deletion?code=<code>. Only a SHA-256 of the user id is kept with the request.
 */

export const META_PROVIDERS = ["facebook-pages", "instagram"];

const b64url = (s: string) => Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");

/** Returns the payload of a valid signed_request, or null. */
export function parseSignedRequest(signedRequest: string, appSecret: string): { user_id?: string; algorithm?: string } | null {
  const [sigPart, payloadPart, extra] = signedRequest.split(".");
  if (!sigPart || !payloadPart || extra !== undefined) return null;
  const expected = createHmac("sha256", appSecret).update(payloadPart).digest();
  const given = b64url(sigPart);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const payload = JSON.parse(b64url(payloadPart).toString("utf8")) as { user_id?: string; algorithm?: string };
    if (String(payload.algorithm ?? "").toUpperCase() !== "HMAC-SHA256") return null;
    return payload;
  } catch {
    return null;
  }
}

export class MetaDataDeletionService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  statusUrl(code: string) {
    return `${env.APP_URL.replace(/\/+$/, "")}/data-deletion?code=${encodeURIComponent(code)}`;
  }

  async handle(rawBody: Buffer): Promise<{ status: number; body: Record<string, unknown> }> {
    if (!env.META_APP_SECRET) return { status: 404, body: { code: "not_found" } };
    const signed = new URLSearchParams(rawBody.toString("utf8")).get("signed_request") ?? "";
    const payload = signed ? parseSignedRequest(signed, env.META_APP_SECRET) : null;
    if (!payload?.user_id) {
      logger.warn("meta data deletion: invalid signed_request");
      return { status: 400, body: { code: "invalid_signed_request" } };
    }
    const subjectHash = sha256(`meta:${payload.user_id}`);
    const confirmationCode = randomToken(9).replace(/[^A-Za-z0-9]/g, "").slice(0, 10).toUpperCase() || randomToken(6);
    const request = await this.db.dataDeletionRequest.create({ data: { confirmationCode, provider: "meta", subjectHash } });

    const connections = await this.db.connection.findMany({ where: { provider: { in: META_PROVIDERS }, externalAccountId: payload.user_id } });
    for (const c of connections) {
      await this.db.$transaction(async (tx) => {
        await tx.webhookSubscription.deleteMany({ where: { connectionId: c.id } });
        await tx.credential.deleteMany({ where: { connectionId: c.id } });
        await tx.connection.update({
          where: { id: c.id },
          data: { status: "REVOKED", externalAccountId: null, displayName: "Removed at your request (Meta)", scopes: [], health: undefined, lastError: null },
        });
        const workflows = await tx.workflow.findMany({ where: { workspaceId: c.workspaceId, status: "ACTIVE" } });
        for (const w of workflows.filter((w) => usesConnection(w.definition, c.id))) await tx.workflow.update({ where: { id: w.id }, data: { status: "PAUSED" } });
      });
      await this.audit.record({ action: "connection.deleted_by_provider_request", workspaceId: c.workspaceId, targetType: "connection", targetId: c.id, metadata: { provider: c.provider, confirmationCode } });
    }
    await this.db.dataDeletionRequest.update({ where: { id: request.id }, data: { status: "COMPLETED", completedAt: new Date(), connectionsAffected: connections.length } });
    logger.info({ confirmationCode, connections: connections.length }, "meta data deletion completed");
    return { status: 200, body: { url: this.statusUrl(confirmationCode), confirmation_code: confirmationCode } };
  }

  async status(code: string) {
    if (!/^[A-Za-z0-9]{4,20}$/.test(code)) return null;
    const r = await this.db.dataDeletionRequest.findUnique({ where: { confirmationCode: code } });
    return r ? { confirmation_code: r.confirmationCode, status: r.status, requested_at: r.createdAt, completed_at: r.completedAt } : null;
  }
}
