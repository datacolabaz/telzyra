import { beforeEach, describe, expect, it } from "vitest";
import { RetentionService } from "../../src/maintenance/retention.js";
import { PgCircuitBreaker } from "../../src/integrations/core/shared-breaker.js";
import { prisma, resetDb } from "../helpers/db.js";

const daysAgo = (d: number) => new Date(Date.now() - d * 86_400_000);

async function seed() {
  const user = await prisma.user.create({ data: { email: "r@example.com", name: "R", passwordHash: "x" } });
  const ws = await prisma.workspace.create({ data: { name: "R", slug: "r" } });
  const wf = await prisma.workflow.create({ data: { workspaceId: ws.id, name: "W", definition: {}, createdById: user.id } });
  const exec = (status: "SUCCEEDED" | "FAILED" | "RUNNING" | "QUEUED", age: number) =>
    prisma.workflowExecution.create({ data: { workspaceId: ws.id, workflowId: wf.id, status, source: "manual", triggerData: { pii: "x" }, createdAt: daysAgo(age) } });
  await Promise.all([exec("SUCCEEDED", 40), exec("FAILED", 31), exec("RUNNING", 40), exec("QUEUED", 45), exec("SUCCEEDED", 29), exec("SUCCEEDED", 1)]);
  const ev = (status: "PROCESSED" | "FAILED" | "DEAD" | "RECEIVED" | "PROCESSING", age: number, i: number) =>
    prisma.webhookEvent.create({ data: { provider: "telegram", dedupeKey: `k${i}`, payload: { pii: "x" }, status, receivedAt: daysAgo(age) } });
  await Promise.all([ev("PROCESSED", 40, 1), ev("DEAD", 35, 2), ev("FAILED", 31, 3), ev("RECEIVED", 40, 4), ev("PROCESSED", 2, 5)]);
  await prisma.auditLog.create({ data: { workspaceId: ws.id, actorUserId: user.id, action: "auth.login.success", createdAt: daysAgo(400) } });
  return { ws, wf };
}

describe("retention policy", () => {
  beforeEach(resetDb);

  it("deletes only finished executions and settled webhook events older than the policy; never audit logs", async () => {
    await seed();
    const r = await new RetentionService(prisma, { executionDays: 30, webhookEventDays: 30, batchSize: 1 }).run();
    expect(r).toEqual({ executions: 2, webhookEvents: 3 });
    expect((await prisma.workflowExecution.findMany({ orderBy: { createdAt: "asc" } })).map((e) => e.status)).toEqual(["QUEUED", "RUNNING", "SUCCEEDED", "SUCCEEDED"]);
    expect((await prisma.webhookEvent.findMany()).map((e) => e.status).sort()).toEqual(["PROCESSED", "RECEIVED"]);
    expect(await prisma.auditLog.count()).toBe(1);
    expect(await prisma.workflow.count()).toBe(1);
  });

  it("0 days keeps everything", async () => {
    await seed();
    expect(await new RetentionService(prisma, { executionDays: 0, webhookEventDays: 0 }).run()).toEqual({ executions: 0, webhookEvents: 0 });
    expect(await prisma.workflowExecution.count()).toBe(6);
  });
});

describe("shared circuit breaker (two instances, one database)", () => {
  beforeEach(resetDb);
  const key = "google-sheets:conn-1";

  it("failures recorded by one instance open the circuit for the other", async () => {
    const a = new PgCircuitBreaker(prisma, 3, 60_000, 0);
    const b = new PgCircuitBreaker(prisma, 3, 60_000, 0);
    await a.failure(key);
    await b.failure(key);
    expect(await a.canRequest(key)).toBe(true);
    await a.failure(key);
    expect(await b.canRequest(key)).toBe(false);
    expect(await a.canRequest(key)).toBe(false);
    expect(await b.canRequest("other:key")).toBe(true);
  });

  it("after the open period exactly one instance gets the half-open probe; success closes for all", async () => {
    const instances = Array.from({ length: 5 }, () => new PgCircuitBreaker(prisma, 1, 300, 0));
    await instances[0]!.failure(key);
    expect(await instances[1]!.canRequest(key)).toBe(false);
    await new Promise((r) => setTimeout(r, 400));
    const results = await Promise.all(instances.map((i) => i.canRequest(key)));
    expect(results.filter(Boolean)).toHaveLength(1);
    const winner = instances[results.indexOf(true)]!;
    await winner.success(key);
    expect(await instances[4]!.canRequest(key)).toBe(true);
    expect((await prisma.circuitBreakerState.findUniqueOrThrow({ where: { key } })).failures).toBe(0);
  });

  it("a failed probe re-opens the circuit", async () => {
    const a = new PgCircuitBreaker(prisma, 1, 300, 0);
    await a.failure(key);
    await new Promise((r) => setTimeout(r, 400));
    expect(await a.canRequest(key)).toBe(true);
    await a.failure(key);
    expect(await a.canRequest(key)).toBe(false);
  });

  it("successes on a healthy key do not write", async () => {
    const a = new PgCircuitBreaker(prisma, 3, 60_000, 60_000);
    expect(await a.canRequest(key)).toBe(true); // caches "closed, 0 failures"
    await a.success(key);
    expect(await prisma.circuitBreakerState.count()).toBe(0);
  });

  it("fails open when the database is unavailable", async () => {
    const broken = { $queryRaw: () => Promise.reject(new Error("down")), $executeRaw: () => Promise.reject(new Error("down")) } as never;
    const b = new PgCircuitBreaker(broken, 1, 60_000, 0);
    await b.failure(key);
    expect(await b.canRequest(key)).toBe(true);
  });
});
