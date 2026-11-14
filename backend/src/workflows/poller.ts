import type { Db } from "../db/client.js";
import { env } from "../config/env.js";
import { logger } from "../lib/logger.js";
import { Prisma } from "../generated/prisma/client.js";
import { ConnectorError } from "../integrations/core/errors.js";
import type { ConnectorRuntime } from "../integrations/core/runtime.js";
import { getConnector } from "../integrations/core/registry.js";
import { QUEUES, type JobQueue } from "../queue/queue.js";
import type { WorkflowDefinition } from "./definition.js";
import type { WorkflowEngine } from "./engine.js";

/**
 * Polling triggers. A per-minute tick enqueues one poll job per due workflow
 * (singletonKey = workflow id, so a slow poll never overlaps with the next one).
 * Each poll stores its checkpoint (cursor) only after the events were dispatched.
 */
export class TriggerPoller {
  constructor(
    private readonly db: Db,
    private readonly runtime: ConnectorRuntime,
    private readonly engine: WorkflowEngine,
    private readonly queue: JobQueue,
    private readonly intervalMinutes = env.POLL_INTERVAL_MINUTES,
  ) {}

  async tick() {
    // Candidates: everything not polled in the last minute; each trigger's own interval is applied below.
    const now = Date.now();
    const states = await this.db.triggerState.findMany({
      where: { workflow: { status: "ACTIVE" }, OR: [{ lastPolledAt: null }, { lastPolledAt: { lt: new Date(now - 55_000) } }] },
      select: { workflowId: true, lastPolledAt: true, workflow: { select: { definition: true } } },
      take: 1000,
    });
    let queued = 0;
    for (const s of states) {
      const def = s.workflow.definition as unknown as WorkflowDefinition;
      const minutes = getConnector(def.trigger.connector)?.triggers[def.trigger.trigger]?.pollIntervalMinutes ?? this.intervalMinutes;
      if (s.lastPolledAt && now - s.lastPolledAt.getTime() < minutes * 60_000 - 5_000) continue;
      await this.queue.send(QUEUES.poll, { workflowId: s.workflowId }, { singletonKey: s.workflowId });
      queued++;
    }
    return queued;
  }

  async poll(workflowId: string) {
    const wf = await this.db.workflow.findUnique({ where: { id: workflowId }, include: { triggerState: true } });
    if (!wf || wf.status !== "ACTIVE" || !wf.triggerConnectionId) return;
    const def = wf.definition as unknown as WorkflowDefinition;
    const connector = getConnector(def.trigger.connector);
    const trigger = connector?.triggers[def.trigger.trigger];
    if (!connector || trigger?.mode !== "polling" || !trigger.poll) return;

    try {
      const ctx = await this.runtime.context(wf.workspaceId, connector, wf.triggerConnectionId);
      const config = trigger.config.parse(def.trigger.config);
      const result = await trigger.poll(ctx, config, wf.triggerState?.cursor ?? undefined);
      const connection = { id: wf.triggerConnectionId, workspaceId: wf.workspaceId, provider: connector.id };
      await this.engine.dispatch(connection, result.events, "poll", wf.id);
      await this.db.triggerState.upsert({
        where: { workflowId: wf.id },
        create: { workflowId: wf.id, cursor: result.cursor as Prisma.InputJsonValue, lastPolledAt: new Date() },
        update: { cursor: result.cursor as Prisma.InputJsonValue, lastPolledAt: new Date(), lastError: null },
      });
    } catch (err) {
      const message = err instanceof ConnectorError ? `${err.code}: ${err.message}` : "poll failed";
      logger.warn({ workflowId, message }, "trigger poll failed");
      await this.db.triggerState.upsert({ where: { workflowId: wf.id }, create: { workflowId: wf.id, lastPolledAt: new Date(), lastError: message }, update: { lastPolledAt: new Date(), lastError: message } });
    }
  }
}
