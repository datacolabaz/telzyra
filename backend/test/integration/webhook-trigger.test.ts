import { http, HttpResponse } from "msw";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prisma, resetDb } from "../helpers/db.js";
import { harness, mockServer, seedOAuthConnection, signUp, type Agent, type Harness } from "../helpers/integrations.js";

/**
 * Inbound Webhook trigger: per-workflow secret URL → execution with the request data.
 * The action step (Slack) is mocked; the Telzyra side (URL, lookup, parsing, dedupe, run) is real.
 */
beforeAll(() => mockServer.listen({ onUnhandledRequest: "error" }));
afterEach(() => mockServer.resetHandlers());
afterAll(() => mockServer.close());

let h: Harness;
let owner: Agent;
let posted: Array<Record<string, string>>;
beforeEach(async () => {
  await resetDb();
  h = harness();
  owner = await signUp(h.app, "hook");
  posted = [];
  mockServer.use(
    http.post("https://slack.com/api/chat.postMessage", async ({ request }) => {
      posted.push(Object.fromEntries(new URLSearchParams(await request.text())));
      return HttpResponse.json({ ok: true, channel: "C1", ts: "1.2" });
    }),
  );
});

async function hookWorkflow() {
  const slack = await seedOAuthConnection(h.services, owner, "slack", { accountId: "T1", expiresAt: null });
  const wf = await owner.post("/v1/workflows", {
    name: "Form → Slack",
    definition: {
      trigger: { connector: "webhook", trigger: "catch_hook", config: {} },
      steps: [{ id: "notify", connector: "slack", action: "send_channel_message", connectionId: slack.id, input: { channel: "C1", text: "Lead: {{trigger.body.name}} <{{trigger.body.email}}>" } }],
    },
  });
  expect(wf.status).toBe(201);
  return wf.body.id as string;
}
const tokenOf = (url: string) => new URL(url).pathname.split("/").pop()!;

describe("Webhook trigger", () => {
  it("is listed as a core connector without a connection", async () => {
    const res = await owner.get("/v1/integrations/webhook");
    expect(res.body).toMatchObject({ id: "webhook", auth: { type: "none" } });
  });

  it("activation creates a secret URL; a JSON POST runs the workflow with the body", async () => {
    const id = await hookWorkflow();
    expect((await owner.get(`/v1/workflows/${id}/webhook`)).body).toEqual({ url: null });
    await owner.post(`/v1/workflows/${id}/activate`, {});
    const { url } = (await owner.get(`/v1/workflows/${id}/webhook`)).body;
    expect(url).toMatch(/^https:\/\/api\.test\.telzyra\.local\/webhooks\/hook\/[A-Za-z0-9_-]{30,}$/);

    const res = await request(h.app).post(`/webhooks/hook/${tokenOf(url)}`).set("Content-Type", "application/json").set("Authorization", "Bearer should-not-leak").send({ name: "Jane", email: "jane@example.com" });
    expect(res.status).toBe(202);
    expect(res.body.status).toBe("accepted");
    await h.queue.drain();

    const exec = await prisma.workflowExecution.findUniqueOrThrow({ where: { id: res.body.execution_id } });
    expect(exec.status).toBe("SUCCEEDED");
    expect(exec.source).toBe("webhook");
    expect(exec.triggerData).toMatchObject({ method: "POST", body: { name: "Jane", email: "jane@example.com" } });
    expect(JSON.stringify(exec.triggerData)).not.toContain("should-not-leak"); // authorization header dropped
    expect(posted[0]!.text).toBe("Lead: Jane <jane@example.com>");
  });

  it("accepts form-urlencoded and plain text bodies", async () => {
    const id = await hookWorkflow();
    await owner.post(`/v1/workflows/${id}/activate`, {});
    const token = tokenOf((await owner.get(`/v1/workflows/${id}/webhook`)).body.url);
    const form = await request(h.app).post(`/webhooks/hook/${token}`).set("Content-Type", "application/x-www-form-urlencoded").send("name=Ali&email=ali%40example.com");
    expect(form.status).toBe(202);
    await h.queue.drain();
    expect(posted.at(-1)!.text).toBe("Lead: Ali <ali@example.com>");
    const text = await request(h.app).post(`/webhooks/hook/${token}`).set("Content-Type", "text/plain").send("hello");
    expect(text.status).toBe(202);
    const exec = await prisma.workflowExecution.findUniqueOrThrow({ where: { id: text.body.execution_id } });
    expect((exec.triggerData as { body: unknown }).body).toBe("hello");
  });

  it("Idempotency-Key runs the workflow only once", async () => {
    const id = await hookWorkflow();
    await owner.post(`/v1/workflows/${id}/activate`, {});
    const token = tokenOf((await owner.get(`/v1/workflows/${id}/webhook`)).body.url);
    const send = () => request(h.app).post(`/webhooks/hook/${token}`).set("Idempotency-Key", "order-42").send({ name: "A", email: "a@example.com" });
    expect((await send()).status).toBe(202);
    const again = await send();
    expect(again.status).toBe(200);
    expect(again.body.status).toBe("duplicate");
    expect(await prisma.workflowExecution.count({ where: { workflowId: id } })).toBe(1);
  });

  it("unknown token, paused workflow and malformed JSON are rejected without running anything", async () => {
    const id = await hookWorkflow();
    await owner.post(`/v1/workflows/${id}/activate`, {});
    const token = tokenOf((await owner.get(`/v1/workflows/${id}/webhook`)).body.url);
    expect((await request(h.app).post(`/webhooks/hook/${"x".repeat(32)}`).send({})).status).toBe(404);
    expect((await request(h.app).post(`/webhooks/hook/${token}`).set("Content-Type", "application/json").send("{bad")).status).toBe(400);
    await owner.post(`/v1/workflows/${id}/pause`, {});
    expect((await request(h.app).post(`/webhooks/hook/${token}`).send({})).status).toBe(404);
    expect(await prisma.workflowExecution.count()).toBe(0);
  });

  it("rotating the URL invalidates the old one immediately", async () => {
    const id = await hookWorkflow();
    await owner.post(`/v1/workflows/${id}/activate`, {});
    const oldToken = tokenOf((await owner.get(`/v1/workflows/${id}/webhook`)).body.url);
    const rotated = await owner.post(`/v1/workflows/${id}/webhook/rotate`, {});
    const newToken = tokenOf(rotated.body.url);
    expect(newToken).not.toBe(oldToken);
    expect((await request(h.app).post(`/webhooks/hook/${oldToken}`).send({ name: "x", email: "x@example.com" })).status).toBe(404);
    expect((await request(h.app).post(`/webhooks/hook/${newToken}`).send({ name: "y", email: "y@example.com" })).status).toBe(202);
  });

  it("another workspace cannot read or rotate the URL", async () => {
    const id = await hookWorkflow();
    await owner.post(`/v1/workflows/${id}/activate`, {});
    const other = await signUp(h.app, "other");
    expect((await other.get(`/v1/workflows/${id}/webhook`)).status).toBe(404);
    expect((await other.post(`/v1/workflows/${id}/webhook/rotate`, {})).status).toBe(404);
  });

  it("only the token's hash is stored", async () => {
    const id = await hookWorkflow();
    await owner.post(`/v1/workflows/${id}/activate`, {});
    const token = tokenOf((await owner.get(`/v1/workflows/${id}/webhook`)).body.url);
    const row = await prisma.workflowHook.findUniqueOrThrow({ where: { workflowId: id } });
    expect(row.tokenHash).not.toContain(token);
    expect(row.tokenEnc).not.toContain(token);
  });
});
