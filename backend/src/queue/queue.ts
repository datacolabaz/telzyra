import { PgBoss } from "pg-boss";
import { logger } from "../lib/logger.js";

/**
 * Background jobs on Postgres (pg-boss): no extra infrastructure, transactional with our data.
 * Each queue has retries with exponential backoff and a dead-letter queue.
 */
export const QUEUES = {
  webhook: "webhook.process",
  webhookDead: "webhook.process.dead",
  execute: "workflow.execute",
  executeDead: "workflow.execute.dead",
  pollTick: "trigger.poll.tick",
  poll: "trigger.poll",
  maintenance: "maintenance.daily",
} as const;

export interface JobQueue {
  send(name: string, data: Record<string, unknown>, opts?: { singletonKey?: string; startAfterSeconds?: number }): Promise<void>;
}

export type Handlers = Partial<Record<(typeof QUEUES)[keyof typeof QUEUES], (data: Record<string, unknown>) => Promise<void>>>;

export class PgBossQueue implements JobQueue {
  readonly boss: PgBoss;
  constructor(connectionString: string) {
    this.boss = new PgBoss({ connectionString, schema: "pgboss" });
    this.boss.on("error", (err) => logger.error({ err: err.message }, "queue error"));
  }

  async start(handlers: Handlers, runWorkers: boolean) {
    await this.boss.start();
    // Dead-letter queues first (target must exist).
    await this.boss.createQueue(QUEUES.webhookDead);
    await this.boss.createQueue(QUEUES.executeDead);
    await this.boss.createQueue(QUEUES.webhook, { retryLimit: 8, retryDelay: 5, retryBackoff: true, retryDelayMax: 3600, deadLetter: QUEUES.webhookDead, expireInSeconds: 300 });
    await this.boss.createQueue(QUEUES.execute, { retryLimit: 2, retryDelay: 10, retryBackoff: true, deadLetter: QUEUES.executeDead, expireInSeconds: 900 });
    await this.boss.createQueue(QUEUES.pollTick, { retryLimit: 0 });
    await this.boss.createQueue(QUEUES.poll, { retryLimit: 1, expireInSeconds: 300 });
    await this.boss.createQueue(QUEUES.maintenance, { retryLimit: 1 });
    if (!runWorkers) return;

    for (const [name, handler] of Object.entries(handlers)) {
      await this.boss.work<Record<string, unknown>>(name, async (jobs) => {
        for (const job of jobs) await handler!(job.data);
      });
    }
    await this.boss.schedule(QUEUES.pollTick, "* * * * *");
    await this.boss.schedule(QUEUES.maintenance, "17 * * * *"); // hourly: retention batches stay small
    logger.info("queue workers started");
  }

  async send(name: string, data: Record<string, unknown>, opts: { singletonKey?: string; startAfterSeconds?: number } = {}) {
    await this.boss.send(name, data, { singletonKey: opts.singletonKey, startAfter: opts.startAfterSeconds });
  }

  async stop() {
    await this.boss.stop({ graceful: true, timeout: 10_000 });
  }
}

/**
 * Runs jobs in-process right after the current call stack (tests, local tools).
 * Errors are captured so tests can assert on them; retries are not simulated.
 */
export class InlineQueue implements JobQueue {
  readonly sent: Array<{ name: string; data: Record<string, unknown> }> = [];
  readonly errors: unknown[] = [];
  private pending: Promise<void>[] = [];
  constructor(private handlers: Handlers = {}) {}

  setHandlers(handlers: Handlers) {
    this.handlers = handlers;
  }

  async send(name: string, data: Record<string, unknown>) {
    this.sent.push({ name, data });
    const handler = this.handlers[name as keyof Handlers];
    if (!handler) return;
    this.pending.push(
      (async () => {
        await Promise.resolve();
        try {
          await handler(data);
        } catch (err) {
          this.errors.push(err);
        }
      })(),
    );
  }

  /** Waits until all jobs (including jobs enqueued by jobs) have finished. */
  async drain() {
    while (this.pending.length) {
      const batch = this.pending;
      this.pending = [];
      await Promise.all(batch);
    }
  }
}
