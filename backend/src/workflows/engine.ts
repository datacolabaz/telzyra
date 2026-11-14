import type { Db } from "../db/client.js";
import { logger } from "../lib/logger.js";
import { Prisma } from "../generated/prisma/client.js";
import { ConnectorError } from "../integrations/core/errors.js";
import type { ConnectorRuntime } from "../integrations/core/runtime.js";
import type { TriggerEvent } from "../integrations/core/types.js";
import { getConnector } from "../integrations/core/registry.js";
import { QUEUES, type JobQueue } from "../queue/queue.js";
import type { WorkflowDefinition } from "./definition.js";
import { resolveTemplates, truncateForStorage } from "./templates.js";

export interface StepRecord {
  stepId: string;
  connector: string;
  action: string;
  status: "succeeded" | "failed" | "skipped";
  output?: unknown;
  error?: { code: string; message: string };
  startedAt: string;
  durationMs: number;
}

/**
 * Telzyra workflow engine (v1, linear).
 *  - createExecution(): records a run (idempotent per workflow + trigger event) and enqueues it
 *  - run(): executes steps in order with template-resolved inputs; each step result is saved
 *    immediately, so a retried job resumes after the last successful step instead of repeating
 *    side effects (e.g. sending the same Telegram message twice).
 */
export class WorkflowEngine {
  constructor(
    private readonly db: Db,
    private readonly runtime: ConnectorRuntime,
    private readonly queue: JobQueue,
  ) {}

  async createExecution(p: { workspaceId: string; workflowId: string; source: "manual" | "test" | "webhook" | "poll"; triggerData: Record<string, unknown>; triggerEventId?: string }) {
    try {
      const exec = await this.db.workflowExecution.create({
        data: {
          workspaceId: p.workspaceId,
          workflowId: p.workflowId,
          source: p.source,
          triggerEventId: p.triggerEventId ?? null,
          triggerData: p.triggerData as Prisma.InputJsonValue,
        },
      });
      await this.queue.send(QUEUES.execute, { executionId: exec.id });
      return exec;
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") return null; // already ran for this event
      throw err;
    }
  }

  /** Starts executions for every active workflow listening to these events on this connection. */
  async dispatch(connection: { id: string; workspaceId: string; provider: string }, events: TriggerEvent[], source: "webhook" | "poll", onlyWorkflowId?: string) {
    if (!events.length) return 0;
    const workflows = await this.db.workflow.findMany({
      where: { workspaceId: connection.workspaceId, triggerConnectionId: connection.id, status: "ACTIVE", ...(onlyWorkflowId ? { id: onlyWorkflowId } : {}) },
    });
    const connector = getConnector(connection.provider);
    let started = 0;
    for (const wf of workflows) {
      const def = wf.definition as unknown as WorkflowDefinition;
      const trigger = connector?.triggers[def.trigger.trigger];
      for (const event of events) {
        if (event.trigger !== def.trigger.trigger) continue;
        const cfg = trigger?.config.safeParse(def.trigger.config);
        if (trigger?.matches && cfg?.success && !trigger.matches(event, cfg.data)) continue;
        const exec = await this.createExecution({ workspaceId: wf.workspaceId, workflowId: wf.id, source, triggerData: event.data, triggerEventId: `${event.trigger}:${event.id}` });
        if (exec) started++;
      }
    }
    return started;
  }

  async run(executionId: string): Promise<void> {
    const exec = await this.db.workflowExecution.findUnique({ where: { id: executionId }, include: { workflow: true } });
    if (!exec || exec.status === "SUCCEEDED" || exec.status === "FAILED") return;
    const def = exec.workflow.definition as unknown as WorkflowDefinition;
    const previous = (Array.isArray(exec.steps) ? exec.steps : []) as unknown as StepRecord[];
    const records: StepRecord[] = previous.filter((s) => s.status === "succeeded");

    await this.db.workflowExecution.update({ where: { id: exec.id }, data: { status: "RUNNING", startedAt: exec.startedAt ?? new Date(), error: null } });
    const scope: Record<string, unknown> = { trigger: exec.triggerData, steps: Object.fromEntries(records.map((r) => [r.stepId, r.output])), now: new Date().toISOString(), execution: { id: exec.id } };

    for (const step of def.steps) {
      if (records.some((r) => r.stepId === step.id)) continue; // resumed run: already done
      const startedAt = new Date();
      try {
        const input = resolveTemplates(step.input, scope);
        const output = await this.runtime.executeAction({
          workspaceId: exec.workspaceId,
          connectorId: step.connector,
          actionKey: step.action,
          connectionId: step.connectionId,
          input,
          idempotencyKey: `tz-${exec.id}-${step.id}`,
        });
        const stored = truncateForStorage(output);
        records.push({ stepId: step.id, connector: step.connector, action: step.action, status: "succeeded", output: stored, startedAt: startedAt.toISOString(), durationMs: Date.now() - startedAt.getTime() });
        (scope.steps as Record<string, unknown>)[step.id] = output;
        await this.save(exec.id, records);
      } catch (err) {
        const e = err instanceof ConnectorError ? err : new ConnectorError("UNKNOWN", err instanceof Error ? err.message : "Step failed");
        records.push({ stepId: step.id, connector: step.connector, action: step.action, status: "failed", error: { code: e.code, message: e.message }, startedAt: startedAt.toISOString(), durationMs: Date.now() - startedAt.getTime() });
        const remaining = def.steps.slice(def.steps.indexOf(step) + 1).map((s): StepRecord => ({ stepId: s.id, connector: s.connector, action: s.action, status: "skipped", startedAt: startedAt.toISOString(), durationMs: 0 }));
        await this.db.workflowExecution.update({
          where: { id: exec.id },
          data: { status: "FAILED", finishedAt: new Date(), error: `${step.id}: ${e.code}`, steps: [...records, ...remaining] as unknown as Prisma.InputJsonValue },
        });
        logger.warn({ executionId: exec.id, step: step.id, code: e.code }, "workflow execution failed");
        return;
      }
    }
    await this.db.workflowExecution.update({ where: { id: exec.id }, data: { status: "SUCCEEDED", finishedAt: new Date(), steps: records as unknown as Prisma.InputJsonValue } });
  }

  private async save(id: string, steps: StepRecord[]) {
    await this.db.workflowExecution.update({ where: { id }, data: { steps: steps as unknown as Prisma.InputJsonValue } });
  }

  /** Called from the dead-letter queue when an execution job exhausted its retries. */
  async markDead(executionId: string) {
    await this.db.workflowExecution.updateMany({ where: { id: executionId, status: { in: ["QUEUED", "RUNNING"] } }, data: { status: "FAILED", finishedAt: new Date(), error: "Execution could not be completed after retries" } });
  }
}
