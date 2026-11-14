import type { Db } from "../db/client.js";
import { logger } from "../lib/logger.js";

export interface RetentionPolicy {
  /** Days to keep finished workflow executions (trigger data + step outputs). 0 = keep forever. */
  executionDays: number;
  /** Days to keep processed/failed/dead webhook events (raw provider payloads). 0 = keep forever. */
  webhookEventDays: number;
  batchSize?: number;
}

/**
 * Deletes personal-data-bearing operational records after the retention period.
 * Scope is deliberately narrow: ONLY workflow_executions (finished) and webhook_events (no longer
 * pending). Audit logs, connections, credentials, workflows and any billing data are never touched.
 * Deletes run in small batches so no long lock is held on busy tables.
 */
export class RetentionService {
  constructor(
    private readonly db: Db,
    private readonly policy: RetentionPolicy,
  ) {}

  async run(): Promise<{ executions: number; webhookEvents: number }> {
    const batch = this.policy.batchSize ?? 1000;
    let executions = 0;
    let webhookEvents = 0;
    if (this.policy.executionDays > 0) {
      for (;;) {
        const n = await this.db.$executeRaw`
          DELETE FROM workflow_executions WHERE id IN (
            SELECT id FROM workflow_executions
            WHERE "createdAt" < now() - (${this.policy.executionDays} * interval '1 day')
              AND status IN ('SUCCEEDED', 'FAILED')
            LIMIT ${batch})`;
        executions += n;
        if (n < batch) break;
      }
    }
    if (this.policy.webhookEventDays > 0) {
      for (;;) {
        const n = await this.db.$executeRaw`
          DELETE FROM webhook_events WHERE id IN (
            SELECT id FROM webhook_events
            WHERE "receivedAt" < now() - (${this.policy.webhookEventDays} * interval '1 day')
              AND status IN ('PROCESSED', 'FAILED', 'DEAD')
            LIMIT ${batch})`;
        webhookEvents += n;
        if (n < batch) break;
      }
    }
    logger.info({ executions, webhookEvents, policy: { executionDays: this.policy.executionDays, webhookEventDays: this.policy.webhookEventDays } }, "retention run");
    return { executions, webhookEvents };
  }
}
