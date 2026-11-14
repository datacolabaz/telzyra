import type { Db } from "../db/client.js";
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
    private readonly intervalMinutes = Number(process.env.POLL_INTERVAL_MINUTES ?? 5),
  ) {}

  async tick() {
    const due = new Date(Date.now() - this.intervalMinutes * 60_000);
    const states = await this.db.triggerState.findMany({
      where: { workflow: { status: "ACTIVE" }, OR: [{ lastPolledAt: null }, { lastPolledAt: { lt: due } }] },
      select: { workflowId: true },
      take: 500,
    });
    for (const s of states) await this.queue.send(QUEUES.poll, { workflowId: s.workflowId }, { singletonKey: s.workflowId });
    return states.length;
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
