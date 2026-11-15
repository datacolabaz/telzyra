import type { Request } from "express";
import type { Db } from "../db/client.js";
import type { CredentialCipher } from "../security/crypto.js";
import { randomToken } from "../security/crypto.js";
import type { AuthContext } from "../auth/session.service.js";
import type { AuditService } from "../audit/audit.service.js";
import { AppError } from "../lib/errors.js";
import { logger } from "../lib/logger.js";
import { forWorkspace } from "../tenancy/scoped-db.js";
import { Prisma } from "../generated/prisma/client.js";
import { ConnectorError } from "../integrations/core/errors.js";
import type { ConnectorRuntime } from "../integrations/core/runtime.js";
import { getConnector } from "../integrations/core/registry.js";
import { MANUAL_TRIGGER, triggerMode, validateDefinition, type WorkflowDefinition } from "./definition.js";
import type { WorkflowEngine } from "./engine.js";
import { resolveTemplates } from "./templates.js";

export const subscriptionSecretAad = (subscriptionId: string) => `webhook-subscription:${subscriptionId}`;

const toJson = (v: unknown) => v as Prisma.InputJsonValue;

function denormalize(def: WorkflowDefinition) {
  const manual = def.trigger.connector === MANUAL_TRIGGER.connector;
  return {
    triggerConnector: manual ? null : def.trigger.connector,
    triggerKey: manual ? null : def.trigger.trigger,
    triggerConnectionId: manual ? null : (def.trigger.connectionId ?? null),
  };
}

export class WorkflowService {
  constructor(
    private readonly db: Db,
    private readonly cipher: CredentialCipher,
    private readonly runtime: ConnectorRuntime,
    private readonly engine: WorkflowEngine,
    private readonly audit: AuditService,
    private readonly publicApiUrl: string,
  ) {}

  private scoped(ctx: AuthContext) {
    return forWorkspace(this.db, ctx.workspaceId);
  }

  async list(ctx: AuthContext) {
    const rows = await this.scoped(ctx).workflow.findMany({ orderBy: { updatedAt: "desc" } });
    return rows.map((w) => ({ id: w.id, name: w.name, status: w.status, trigger: (w.definition as unknown as WorkflowDefinition).trigger, steps: (w.definition as unknown as WorkflowDefinition).steps.length, updatedAt: w.updatedAt }));
  }

  async get(ctx: AuthContext, id: string) {
    const w = await this.scoped(ctx).workflow.findUnique({ where: { id } });
    if (!w) throw new AppError(404, "not_found");
    return w;
  }

  async create(ctx: AuthContext, input: { name?: unknown; definition?: unknown }, req?: Request) {
    const name = String(input.name ?? "").trim().slice(0, 200) || "Untitled workflow";
    const def = await validateDefinition(this.scoped(ctx), input.definition);
    const w = await this.scoped(ctx).workflow.create({ data: { name, definition: toJson(def), createdById: ctx.userId, ...denormalize(def) } as never });
    await this.audit.record({ action: "workflow.created", workspaceId: ctx.workspaceId, actorUserId: ctx.userId, targetType: "workflow", targetId: w.id }, req);
    return w;
  }

  async update(ctx: AuthContext, id: string, input: { name?: unknown; definition?: unknown }) {
    const w = await this.get(ctx, id);
    const def = input.definition !== undefined ? await validateDefinition(this.scoped(ctx), input.definition) : (w.definition as unknown as WorkflowDefinition);
    const updated = await this.scoped(ctx).workflow.update({
      where: { id },
      data: { name: input.name !== undefined ? String(input.name).trim().slice(0, 200) || w.name : w.name, definition: toJson(def), ...denormalize(def) },
    });
    if (updated.status === "ACTIVE") await this.ensureTrigger(ctx, updated.id, def); // keep subscriptions in sync
    return updated;
  }

  async remove(ctx: AuthContext, id: string) {
    await this.get(ctx, id);
    await this.scoped(ctx).workflow.delete({ where: { id } });
  }

  /** Activation registers the trigger at the provider (webhook) or creates a polling checkpoint. */
  async activate(ctx: AuthContext, id: string, req?: Request) {
    const w = await this.get(ctx, id);
    const def = await validateDefinition(this.scoped(ctx), w.definition);
    await this.ensureTrigger(ctx, w.id, def);
    const updated = await this.scoped(ctx).workflow.update({ where: { id }, data: { status: "ACTIVE" } });
    await this.audit.record({ action: "workflow.activated", workspaceId: ctx.workspaceId, actorUserId: ctx.userId, targetType: "workflow", targetId: w.id, metadata: { trigger: `${def.trigger.connector}.${def.trigger.trigger}` } }, req);
    return updated;
  }

  async pause(ctx: AuthContext, id: string) {
    await this.get(ctx, id);
    return this.scoped(ctx).workflow.update({ where: { id }, data: { status: "PAUSED" } });
  }

  private async ensureTrigger(ctx: AuthContext, workflowId: string, def: WorkflowDefinition) {
    const mode = triggerMode(def);
    if (mode === "polling") {
      const t = getConnector(def.trigger.connector)?.triggers[def.trigger.trigger];
      if (t?.exclusivePerConnection && def.trigger.connectionId) {
        const others = await this.db.workflow.count({
          where: { workspaceId: ctx.workspaceId, id: { not: workflowId }, status: "ACTIVE", triggerConnectionId: def.trigger.connectionId, triggerConnector: def.trigger.connector },
        });
        if (others > 0) throw new AppError(409, "workflow.trigger_in_use");
      }
      await this.db.triggerState.upsert({ where: { workflowId }, create: { workflowId }, update: {} });
      return;
    }
    if (mode !== "webhook" || !def.trigger.connectionId) return;
    const connector = getConnector(def.trigger.connector)!;
    const spec = connector.webhook;
    if (!spec || spec.routing === "app") return; // app-level webhooks are configured once for the Telzyra app

    // One provider subscription per connection, shared by all workflows using it.
    const existing = await this.db.webhookSubscription.findFirst({ where: { workspaceId: ctx.workspaceId, connectionId: def.trigger.connectionId, status: "ACTIVE" } });
    if (existing && existing.callbackBase === this.publicApiUrl) return;
    if (existing) {
      // The public webhook URL changed (new domain or tunnel): remove the stale registration first.
      try {
        const cctx = await this.runtime.context(ctx.workspaceId, connector, def.trigger.connectionId);
        await spec.unsubscribe?.(cctx, existing.externalId);
      } catch (err) {
        logger.warn({ provider: connector.id, code: err instanceof ConnectorError ? err.code : "UNKNOWN" }, "stale webhook unsubscribe failed");
      }
      await this.db.webhookSubscription.delete({ where: { id: existing.id } });
    }
    const endpointToken = randomToken(24);
    const secret = randomToken(32);
    const sub = await this.db.webhookSubscription.create({
      data: { workspaceId: ctx.workspaceId, connectionId: def.trigger.connectionId, provider: connector.id, endpointToken, eventTypes: [], status: "PAUSED" },
    });
    try {
      const cctx = await this.runtime.context(ctx.workspaceId, connector, def.trigger.connectionId);
      const url = `${this.publicApiUrl}/webhooks/${connector.id}/${endpointToken}`;
      const result = (await spec.subscribe?.(cctx, { url, secret, events: [] })) ?? {};
      await this.db.webhookSubscription.update({
        where: { id: sub.id },
        data: { status: "ACTIVE", callbackBase: this.publicApiUrl, externalId: result.externalId ?? null, signingSecret: this.cipher.encrypt(result.signingSecret ?? secret, subscriptionSecretAad(sub.id)) },
      });
      await this.audit.record({ action: "webhook.subscription.created", workspaceId: ctx.workspaceId, actorUserId: ctx.userId, targetType: "connection", targetId: def.trigger.connectionId, metadata: { provider: connector.id } });
    } catch (err) {
      await this.db.webhookSubscription.delete({ where: { id: sub.id } });
      const code = err instanceof ConnectorError ? err.code : "UNKNOWN";
      logger.warn({ provider: connector.id, code }, "webhook subscription failed");
      throw new AppError(502, "workflow.trigger_registration_failed", { providerCode: code });
    }
  }

  /** Manual run. With wait=true the run executes inline and the result is returned (builder "Run test"). */
  async run(ctx: AuthContext, id: string, triggerData: Record<string, unknown> | undefined, wait: boolean) {
    const w = await this.get(ctx, id);
    const def = w.definition as unknown as WorkflowDefinition;
    const sample = def.trigger.connector === MANUAL_TRIGGER.connector ? {} : (getConnector(def.trigger.connector)?.triggers[def.trigger.trigger]?.sample ?? {});
    const exec = await this.engine.createExecution({ workspaceId: ctx.workspaceId, workflowId: w.id, source: wait ? "test" : "manual", triggerData: triggerData ?? sample });
    if (!exec) throw new AppError(409, "workflow.duplicate_run");
    if (wait) {
      await this.engine.run(exec.id);
      return this.execution(ctx, exec.id);
    }
    return exec;
  }

  /** "Test node": runs one action with the given input, outside any workflow. */
  async testStep(ctx: AuthContext, input: { connector?: unknown; action?: unknown; connectionId?: unknown; input?: unknown; triggerData?: unknown; steps?: unknown }, req?: Request) {
    try {
      // Templates are resolved like in a real run, using the given (sample) trigger data and step outputs.
      const scope = {
        trigger: input.triggerData && typeof input.triggerData === "object" ? input.triggerData : {},
        steps: input.steps && typeof input.steps === "object" ? input.steps : {},
        now: new Date().toISOString(),
      };
      const output = await this.runtime.executeAction({
        workspaceId: ctx.workspaceId,
        connectorId: String(input.connector ?? ""),
        actionKey: String(input.action ?? ""),
        connectionId: input.connectionId ? String(input.connectionId) : null,
        input: resolveTemplates(input.input ?? {}, scope),
      });
      await this.audit.record({ action: "connection.tested", workspaceId: ctx.workspaceId, actorUserId: ctx.userId, metadata: { connector: input.connector, action: input.action, ok: true } }, req);
      return { ok: true, output };
    } catch (err) {
      const e = err instanceof ConnectorError ? err : new ConnectorError("UNKNOWN", "Step failed");
      return { ok: false, error: { code: e.code, message: e.message } };
    }
  }

  async executions(ctx: AuthContext, workflowId: string) {
    await this.get(ctx, workflowId);
    return this.scoped(ctx).workflowExecution.findMany({ where: { workflowId }, orderBy: { createdAt: "desc" }, take: 50 });
  }

  async execution(ctx: AuthContext, id: string) {
    const e = await this.scoped(ctx).workflowExecution.findUnique({ where: { id } });
    if (!e) throw new AppError(404, "not_found");
    return e;
  }
}
