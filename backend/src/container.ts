import type { Db } from "./db/client.js";
import type { CredentialCipher } from "./security/crypto.js";
import { env, webhookBaseUrl } from "./config/env.js";
import { AuditService } from "./audit/audit.service.js";
import { CredentialService } from "./integrations/connections/credential.service.js";
import { ConnectionService } from "./integrations/connections/connection.service.js";
import { ConnectorRuntime } from "./integrations/core/runtime.js";
import { OAuthService } from "./integrations/oauth/oauth.service.js";
import { registerBuiltInConnectors } from "./integrations/providers/index.js";
import { WebhookService } from "./integrations/webhooks/webhook.service.js";
import { QUEUES, type Handlers, type JobQueue } from "./queue/queue.js";
import { WorkflowEngine } from "./workflows/engine.js";
import { TriggerPoller } from "./workflows/poller.js";
import { RetentionService } from "./maintenance/retention.js";
import type { PgCircuitBreaker } from "./integrations/core/shared-breaker.js";
import { WorkflowService } from "./workflows/workflow.service.js";
import { WorkflowHookService } from "./workflows/hooks.js";

export type Services = ReturnType<typeof createServices>;

/** Wires the integration services. One instance per process (and per test). */
export function createServices(db: Db, cipher: CredentialCipher, queue: JobQueue, opts: { http?: ConstructorParameters<typeof ConnectorRuntime>[2]; breaker?: PgCircuitBreaker } = {}) {
  registerBuiltInConnectors();
  const audit = new AuditService(db);
  const credentials = new CredentialService(db, cipher);
  const runtime = new ConnectorRuntime(db, credentials, opts.http);
  const oauth = new OAuthService(db, cipher, credentials, audit);
  const connections = new ConnectionService(db, credentials, runtime, audit);
  const engine = new WorkflowEngine(db, runtime, queue);
  const hooks = new WorkflowHookService(db, cipher, engine);
  const workflows = new WorkflowService(db, cipher, runtime, engine, audit, webhookBaseUrl(), hooks);
  const poller = new TriggerPoller(db, runtime, engine, queue);
  const webhooks = new WebhookService(db, cipher, queue, engine, audit);
  const retention = new RetentionService(db, { executionDays: env.EXECUTION_RETENTION_DAYS, webhookEventDays: env.WEBHOOK_EVENT_RETENTION_DAYS });
  return { db, audit, credentials, runtime, oauth, connections, engine, workflows, hooks, poller, webhooks, retention, breaker: opts.breaker, queue };
}

/** Job handlers for the queue workers. */
export function jobHandlers(s: Services): Handlers {
  const id = (d: Record<string, unknown>, k: string) => String(d[k] ?? "");
  return {
    [QUEUES.webhook]: (d) => s.webhooks.process(id(d, "eventId")),
    [QUEUES.webhookDead]: (d) => s.webhooks.markDead(id(d, "eventId")),
    [QUEUES.execute]: (d) => s.engine.run(id(d, "executionId")),
    [QUEUES.executeDead]: (d) => s.engine.markDead(id(d, "executionId")),
    [QUEUES.pollTick]: async () => void (await s.poller.tick()),
    [QUEUES.poll]: (d) => s.poller.poll(id(d, "workflowId")),
    [QUEUES.maintenance]: async () => {
      await s.oauth.purgeExpired();
      await s.retention.run();
      await s.breaker?.prune();
    },
  };
}
