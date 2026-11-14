import type { Request } from "express";
import type { Db } from "../../db/client.js";
import type { CredentialCipher } from "../../security/crypto.js";
import { sha256 } from "../../security/crypto.js";
import type { AuthContext } from "../../auth/session.service.js";
import type { AuditService } from "../../audit/audit.service.js";
import { AppError } from "../../lib/errors.js";
import { logger } from "../../lib/logger.js";
import { Prisma } from "../../generated/prisma/client.js";
import { getConnector } from "../core/registry.js";
import type { ParsedWebhook, RawWebhookRequest } from "../core/types.js";
import { QUEUES, type JobQueue } from "../../queue/queue.js";
import type { WorkflowEngine } from "../../workflows/engine.js";
import { subscriptionSecretAad } from "../../workflows/workflow.service.js";

export const NOTION_VERIFICATION_AAD = "notion-webhook-verification";

export interface IngestResult {
  status: number;
  body: unknown;
}

/**
 * Inbound webhooks:
 *   ingest()  — synchronous, fast: resolve subscription, verify signature (+ timestamp window
 *               inside each provider's verify), dedupe by provider event id, persist, enqueue.
 *   process() — asynchronous (queue): convert the payload to trigger events and start workflows.
 *               Failures are retried with backoff; exhausted events are marked DEAD and can be replayed.
 */
export class WebhookService {
  constructor(
    private readonly db: Db,
    private readonly cipher: CredentialCipher,
    private readonly queue: JobQueue,
    private readonly engine: WorkflowEngine,
    private readonly audit: AuditService,
  ) {}

  async ingest(provider: string, endpointToken: string | undefined, raw: RawWebhookRequest): Promise<IngestResult> {
    const def = getConnector(provider);
    const spec = def?.webhook;
    if (!def || !spec) return { status: 404, body: { code: "not_found" } };

    let sub: { id: string; workspaceId: string; connectionId: string; signingSecret: string | null } | null = null;
    if (spec.routing === "per-connection") {
      if (!endpointToken || endpointToken.length > 100) return { status: 404, body: { code: "not_found" } };
      sub = await this.db.webhookSubscription.findFirst({ where: { provider, endpointToken, status: "ACTIVE" }, select: { id: true, workspaceId: true, connectionId: true, signingSecret: true } });
      if (!sub) return { status: 404, body: { code: "not_found" } };
    } else if (endpointToken) {
      return { status: 404, body: { code: "not_found" } };
    }

    const secret = sub?.signingSecret ? this.cipher.decrypt(sub.signingSecret, subscriptionSecretAad(sub.id)) : undefined;
    let ok = false;
    try {
      ok = spec.verify(raw, secret);
    } catch {
      ok = false;
    }
    if (!ok) {
      logger.warn({ provider, subscription: sub?.id ?? null }, "webhook signature rejected");
      return { status: 401, body: { code: "webhook.invalid_signature" } };
    }

    let parsed: ParsedWebhook;
    try {
      parsed = spec.parse(raw);
    } catch {
      return { status: 400, body: { code: "webhook.invalid_payload" } };
    }
    if (parsed.challenge !== undefined) return { status: 200, body: parsed.challenge };

    // Items without a payload are provider pings or event types we do not handle: acknowledge them.
    const items = (parsed.batch ?? [parsed]).filter((i) => i.payload !== undefined && i.payload !== null);
    let accepted = 0;
    for (const item of items) {
      const baseKey = item.dedupeKey ?? sha256(raw.rawBody.toString("utf8"));
      const dedupeKey = sub ? `${sub.id}:${baseKey}` : baseKey;
      let payload = item.payload ?? null;
      if (provider === "notion" && item.eventType === "verification") {
        // The one-time token is a secret: store it encrypted; read it with `npm run notion:verification-token`.
        const token = String((payload as { verification_token?: string })?.verification_token ?? "");
        payload = { encryptedToken: this.cipher.encrypt(token, NOTION_VERIFICATION_AAD) };
      }
      try {
        const event = await this.db.webhookEvent.create({
          data: {
            provider,
            dedupeKey: dedupeKey.slice(0, 300),
            workspaceId: sub?.workspaceId ?? null,
            connectionId: sub?.connectionId ?? null,
            subscriptionId: sub?.id ?? null,
            accountId: item.accountId ?? null,
            eventType: item.eventType?.slice(0, 200) ?? null,
            payload: payload as Prisma.InputJsonValue,
          },
        });
        await this.queue.send(QUEUES.webhook, { eventId: event.id });
        accepted++;
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") continue; // duplicate delivery
        throw err;
      }
    }
    return { status: 200, body: { received: true, accepted, duplicates: items.length - accepted } };
  }

  /**
   * Shopify mandatory compliance webhooks (customers/data_request, customers/redact, shop/redact).
   * Telzyra stores no Shopify customer records outside workflow run history; shop/redact removes
   * the shop's connections and credentials (48 hours after uninstall, per Shopify).
   */
  async shopifyCompliance(raw: RawWebhookRequest): Promise<IngestResult> {
    const def = getConnector("shopify");
    if (!def?.webhook?.verify(raw)) return { status: 401, body: { code: "webhook.invalid_signature" } };
    const topic = raw.headers["x-shopify-topic"] ?? "";
    const shop = raw.headers["x-shopify-shop-domain"] ?? "";
    if (topic === "shop/redact" && shop) {
      const conns = await this.db.connection.findMany({ where: { provider: "shopify", externalAccountId: shop }, select: { id: true } });
      const ids = conns.map((c) => c.id);
      await this.db.$transaction([
        this.db.credential.deleteMany({ where: { connectionId: { in: ids } } }),
        this.db.webhookSubscription.deleteMany({ where: { connectionId: { in: ids } } }),
        this.db.connection.updateMany({ where: { id: { in: ids } }, data: { status: "REVOKED", lastError: "Shop data redacted" } }),
      ]);
    }
    logger.info({ topic, connectionsAffected: topic === "shop/redact" }, "shopify compliance webhook");
    return { status: 200, body: { received: true } };
  }

  async process(eventId: string) {
    const event = await this.db.webhookEvent.findUnique({ where: { id: eventId } });
    if (!event || event.status === "PROCESSED" || event.status === "DEAD") return;
    await this.db.webhookEvent.update({ where: { id: event.id }, data: { status: "PROCESSING", attempts: { increment: 1 } } });
    try {
      if (event.eventType === "verification") {
        await this.db.webhookEvent.update({ where: { id: event.id }, data: { status: "PROCESSED", processedAt: new Date() } });
        return;
      }
      const def = getConnector(event.provider);
      if (!def?.webhook) throw new Error("connector has no webhook support");

      // Resolve the tenant(s): per-connection subscriptions know their connection; app-level
      // events are routed by provider account id to every ACTIVE connection of that account.
      const connections = event.connectionId
        ? await this.db.connection.findMany({ where: { id: event.connectionId, status: "ACTIVE" } })
        : event.accountId
          ? await this.db.connection.findMany({ where: { provider: event.provider, externalAccountId: event.accountId, status: "ACTIVE" } })
          : [];

      const triggerEvents = def.webhook.toEvents(event.payload, event.eventType ?? undefined);
      let started = 0;
      for (const c of connections) started += await this.engine.dispatch(c, triggerEvents, "webhook");
      await this.db.webhookEvent.update({
        where: { id: event.id },
        data: { status: "PROCESSED", processedAt: new Date(), lastError: null, ...(connections.length === 1 && !event.workspaceId ? { workspaceId: connections[0]!.workspaceId, connectionId: connections[0]!.id } : {}) },
      });
      logger.info({ provider: event.provider, eventId: event.id, connections: connections.length, started }, "webhook processed");
    } catch (err) {
      const message = err instanceof Error ? err.message.slice(0, 500) : "processing failed";
      await this.db.webhookEvent.update({ where: { id: event.id }, data: { status: "FAILED", lastError: message } });
      throw err; // queue retries with backoff, then dead-letters
    }
  }

  async markDead(eventId: string) {
    await this.db.webhookEvent.updateMany({ where: { id: eventId, status: { not: "PROCESSED" } }, data: { status: "DEAD" } });
  }

  /** Recent events of the workspace — metadata only, payloads may contain personal data. */
  async list(ctx: AuthContext) {
    return this.db.webhookEvent.findMany({
      where: { workspaceId: ctx.workspaceId },
      orderBy: { receivedAt: "desc" },
      take: 100,
      select: { id: true, provider: true, eventType: true, status: true, attempts: true, lastError: true, receivedAt: true, processedAt: true },
    });
  }

  async replay(ctx: AuthContext, eventId: string, req?: Request) {
    const event = await this.db.webhookEvent.findFirst({ where: { id: eventId, workspaceId: ctx.workspaceId } });
    if (!event) throw new AppError(404, "not_found");
    if (event.status !== "DEAD" && event.status !== "FAILED") throw new AppError(409, "webhook.not_replayable");
    await this.db.webhookEvent.update({ where: { id: event.id }, data: { status: "RECEIVED", lastError: null } });
    await this.queue.send(QUEUES.webhook, { eventId: event.id });
    await this.audit.record({ action: "webhook.event.replayed", workspaceId: ctx.workspaceId, actorUserId: ctx.userId, targetType: "webhook_event", targetId: event.id }, req);
    return { replayed: true };
  }
}
