import { http, HttpResponse } from "msw";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { slackSignature } from "../../src/integrations/providers/slack.js";
import { stripeSignatureHeader } from "../../src/integrations/providers/stripe.js";
import { prisma, resetDb } from "../helpers/db.js";
import { harness, mockServer, seedOAuthConnection, signUp, type Agent, type Harness } from "../helpers/integrations.js";

const BOT_TOKEN = "123456:TEST-bot-token-not-real";
const TG = `https://api.telegram.org/bot${BOT_TOKEN}`;
const SHEETS = "https://sheets.googleapis.com/v4/spreadsheets";

beforeAll(() => mockServer.listen({ onUnhandledRequest: "error" }));
afterEach(() => mockServer.resetHandlers());
afterAll(() => mockServer.close());

let h: Harness;
let owner: Agent;

beforeEach(async () => {
  await resetDb();
  h = harness();
  owner = await signUp(h.app, "owner");
});

function telegramGetMe() {
  return http.post(`${TG}/getMe`, () => HttpResponse.json({ ok: true, result: { id: 777, is_bot: true, username: "telzyra_test_bot", first_name: "Telzyra Test" } }));
}

async function connectTelegram(a: Agent = owner) {
  mockServer.use(telegramGetMe());
  const res = await a.post("/v1/connections", { connector: "telegram", secret: BOT_TOKEN });
  expect(res.status).toBe(201);
  return res.body as { id: string };
}

describe("catalog and access control", () => {
  it("requires a session and lists all connectors with schemas", async () => {
    expect((await request(h.app).get("/v1/integrations")).status).toBe(401);
    const res = await owner.get("/v1/integrations");
    expect(res.status).toBe(200);
    const ids = res.body.map((c: { id: string }) => c.id);
    expect(ids).toEqual(expect.arrayContaining(["telegram", "google-sheets", "slack", "notion", "gmail", "hubspot", "stripe", "shopify", "http"]));
    const sheets = res.body.find((c: { id: string }) => c.id === "google-sheets");
    expect(sheets.configured).toBe(true);
    expect(sheets.actions.find((a: { key: string }) => a.key === "append_row").inputSchema.properties).toHaveProperty("values");
  });

  it("rejects state-changing calls without the CSRF token", async () => {
    const res = await request(h.app).post("/v1/connections").set("Cookie", owner.cookie).send({ connector: "telegram", secret: BOT_TOKEN });
    expect(res.status).toBe(403);
  });

  it("only OWNER/ADMIN can manage connections", async () => {
    await prisma.membership.updateMany({ where: { userId: owner.userId }, data: { role: "MEMBER" } });
    const res = await owner.post("/v1/connections", { connector: "telegram", secret: BOT_TOKEN });
    expect(res.status).toBe(403);
  });
});

describe("token connections (Telegram)", () => {
  it("validates the token with the provider, stores it encrypted and never returns it", async () => {
    const conn = await connectTelegram();
    const row = await prisma.connection.findUniqueOrThrow({ where: { id: conn.id }, include: { credential: true } });
    expect(row.displayName).toContain("telzyra_test_bot");
    expect(row.credential!.secret).toMatch(/^tz1\./);
    expect(row.credential!.secret).not.toContain(BOT_TOKEN);
    const list = await owner.get("/v1/connections");
    expect(JSON.stringify(list.body)).not.toContain(BOT_TOKEN);
    const audit = await prisma.auditLog.findMany({ where: { workspaceId: owner.workspaceId } });
    expect(JSON.stringify(audit)).not.toContain(BOT_TOKEN);
  });

  it("rejects an invalid token without creating a connection", async () => {
    mockServer.use(http.post(`${TG}/getMe`, () => HttpResponse.json({ ok: false, error_code: 401, description: "Unauthorized" }, { status: 401 })));
    const res = await owner.post("/v1/connections", { connector: "telegram", secret: BOT_TOKEN });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await prisma.connection.count()).toBe(0);
  });

  it("isolates connections between workspaces", async () => {
    const conn = await connectTelegram();
    const other = await signUp(h.app, "intruder");
    expect((await other.get(`/v1/connections/${conn.id}`)).status).toBe(404);
    expect((await other.post(`/v1/connections/${conn.id}/test`)).status).toBe(404);
    expect((await other.post("/v1/workflows/test-step", { connector: "telegram", action: "get_chat", connectionId: conn.id, input: { chat_id: 1 } })).body).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
  });

  it("marks the connection revoked when the provider rejects the token", async () => {
    const conn = await connectTelegram();
    mockServer.use(http.post(`${TG}/getChat`, () => HttpResponse.json({ ok: false, error_code: 401, description: "Unauthorized" }, { status: 401 })));
    const res = await owner.post("/v1/workflows/test-step", { connector: "telegram", action: "get_chat", connectionId: conn.id, input: { chat_id: 5 } });
    expect(res.body).toMatchObject({ ok: false, error: { code: "AUTH_REVOKED" } });
    expect((await prisma.connection.findUniqueOrThrow({ where: { id: conn.id } })).status).toBe("REVOKED");
  });
});

describe("OAuth 2.0 (Google)", () => {
  async function start() {
    const res = await owner.post("/v1/oauth/google-sheets/start", { redirectPath: "/dashboard/integrations" });
    expect(res.status).toBe(200);
    const url = new URL(res.body.url);
    return { url, state: url.searchParams.get("state")! };
  }

  it("builds a PKCE authorization URL with the exact redirect URI", async () => {
    const { url } = await start();
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(url.searchParams.get("redirect_uri")).toBe("https://api.test.telzyra.local/v1/oauth/google/callback");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(url.searchParams.get("access_type")).toBe("offline");
  });

  it("completes the callback once, stores tokens encrypted, and rejects state replay", async () => {
    const { state } = await start();
    let tokenBody = "";
    mockServer.use(
      http.post("https://oauth2.googleapis.com/token", async ({ request }) => {
        tokenBody = await request.text();
        return HttpResponse.json({ access_token: "ya29.access", refresh_token: "1//refresh", expires_in: 3599, scope: "openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/spreadsheets" });
      }),
      http.get("https://openidconnect.googleapis.com/v1/userinfo", () => HttpResponse.json({ sub: "g-123", email: "sheets@example.com" })),
    );
    const cb = await request(h.app).get(`/v1/oauth/google/callback?state=${state}&code=auth-code-1`).set("Cookie", owner.cookie);
    expect(cb.status).toBe(303);
    expect(cb.headers.location).toMatch(/^http:\/\/localhost:3000\/dashboard\/integrations\?status=connected/);
    expect(new URLSearchParams(tokenBody).get("code_verifier")).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
    const conn = await prisma.connection.findFirstOrThrow({ where: { provider: "google-sheets" }, include: { credential: true } });
    expect(conn.externalAccountId).toBe("g-123");
    expect(conn.credential!.secret).not.toContain("ya29.access");

    const replay = await request(h.app).get(`/v1/oauth/google/callback?state=${state}&code=auth-code-1`).set("Cookie", owner.cookie);
    expect(replay.headers.location).toContain("status=error");
  });

  it("rejects a callback from another session (login CSRF)", async () => {
    const { state } = await start();
    const other = await signUp(h.app, "attacker");
    const cb = await request(h.app).get(`/v1/oauth/google/callback?state=${state}&code=x`).set("Cookie", other.cookie);
    expect(cb.headers.location).toContain("reason=oauth.session_mismatch");
    expect(await prisma.connection.count()).toBe(0);
  });

  it("handles a denied consent and an unknown state", async () => {
    const { state } = await start();
    const denied = await request(h.app).get(`/v1/oauth/google/callback?state=${state}&error=access_denied`).set("Cookie", owner.cookie);
    expect(denied.headers.location).toContain("reason=oauth.denied");
    const bogus = await request(h.app).get(`/v1/oauth/google/callback?state=nope&code=x`).set("Cookie", owner.cookie);
    expect(bogus.headers.location).toContain("reason=oauth.invalid_state");
  });

  it("refreshes an expired token once even under concurrent use", async () => {
    const conn = await seedOAuthConnection(h.services, owner, "google-sheets", { expiresAt: new Date(Date.now() - 1000) });
    let refreshes = 0;
    mockServer.use(
      http.post("https://oauth2.googleapis.com/token", async () => {
        refreshes++;
        await new Promise((r) => setTimeout(r, 30));
        return HttpResponse.json({ access_token: "fresh-token", expires_in: 3599, scope: "https://www.googleapis.com/auth/spreadsheets" });
      }),
      http.get(`${SHEETS}/:id`, ({ request }) => {
        expect(request.headers.get("authorization")).toBe("Bearer fresh-token");
        return HttpResponse.json({ spreadsheetId: "1PollSheetXYZabc", properties: { title: "T" }, sheets: [{ properties: { sheetId: 0, title: "Sheet1", index: 0, gridProperties: { rowCount: 10, columnCount: 5 } } }] });
      }),
    );
    const run = () => h.services.runtime.executeAction({ workspaceId: owner.workspaceId, connectorId: "google-sheets", actionKey: "list_sheets", connectionId: conn.id, input: { spreadsheet_id: "1PollSheetXYZabc" } });
    await Promise.all([run(), run(), run()]);
    expect(refreshes).toBe(1);
  });

  it("marks the connection expired when the refresh token is revoked", async () => {
    const conn = await seedOAuthConnection(h.services, owner, "google-sheets", { expiresAt: new Date(Date.now() - 1000) });
    mockServer.use(http.post("https://oauth2.googleapis.com/token", () => HttpResponse.json({ error: "invalid_grant" }, { status: 400 })));
    await expect(h.services.runtime.executeAction({ workspaceId: owner.workspaceId, connectorId: "google-sheets", actionKey: "list_sheets", connectionId: conn.id, input: { spreadsheet_id: "1PollSheetXYZabc" } })).rejects.toMatchObject({ code: "AUTH_EXPIRED" });
    expect((await prisma.connection.findUniqueOrThrow({ where: { id: conn.id } })).status).toBe("EXPIRED");
  });
});

describe("sample workflow: Telegram message → Google Sheets row → Telegram reply", () => {
  async function setup() {
    const tg = await connectTelegram();
    const sheets = await seedOAuthConnection(h.services, owner, "google-sheets");
    let webhook: { url: string; secret_token: string } | undefined;
    mockServer.use(http.post(`${TG}/setWebhook`, async ({ request }) => {
      webhook = (await request.json()) as typeof webhook;
      return HttpResponse.json({ ok: true, result: true });
    }));
    const definition = {
      trigger: { connector: "telegram", trigger: "new_message", connectionId: tg.id, config: {} },
      steps: [
        { id: "save", connector: "google-sheets", action: "append_row", connectionId: sheets.id, input: { spreadsheet_id: "1SheetAbcDEFghij", sheet: "Leads", values: ["{{trigger.from.username}}", "{{trigger.text}}", "{{trigger.chat.id}}"] } },
        { id: "reply", connector: "telegram", action: "send_message", connectionId: tg.id, input: { chat_id: "{{trigger.chat.id}}", text: "Saved to {{steps.save.updated_range}}", reply_to_message_id: "{{trigger.message_id}}" } },
      ],
    };
    const created = await owner.post("/v1/workflows", { name: "Leads from Telegram", definition });
    expect(created.status).toBe(201);
    const activated = await owner.post(`/v1/workflows/${created.body.id}/activate`);
    expect(activated.status).toBe(200);
    expect(webhook?.url).toMatch(/^https:\/\/api\.test\.telzyra\.local\/webhooks\/telegram\/[A-Za-z0-9_-]+$/);
    return { workflowId: created.body.id as string, webhook: webhook! };
  }

  const update = (id: number, text = "Hello, I want a demo") => ({ update_id: id, message: { message_id: 55, date: 1767225600, text, chat: { id: 9001, type: "private", username: "jane" }, from: { id: 9001, is_bot: false, username: "jane", first_name: "Jane" } } });

  it("runs end to end through the Telzyra engine", async () => {
    const { workflowId, webhook } = await setup();
    const calls: Record<string, unknown> = {};
    mockServer.use(
      http.post(`${SHEETS}/:id/values/:range`, async ({ request, params }) => {
        calls.sheets = { id: params.id, range: params.range, url: request.url, body: await request.json() };
        return HttpResponse.json({ updates: { updatedRange: "Leads!A2:C2", updatedRows: 1 } });
      }),
      http.post(`${TG}/sendMessage`, async ({ request }) => {
        calls.reply = await request.json();
        return HttpResponse.json({ ok: true, result: { message_id: 56, date: 1767225601, chat: { id: 9001, type: "private" } } });
      }),
    );

    const path = new URL(webhook.url).pathname;
    const res = await request(h.app).post(path).set("X-Telegram-Bot-Api-Secret-Token", webhook.secret_token).send(update(1001));
    expect(res.status).toBe(200);
    await h.queue.drain();
    expect(h.queue.errors).toEqual([]);

    const exec = await prisma.workflowExecution.findFirstOrThrow({ where: { workflowId } });
    expect(exec.status).toBe("SUCCEEDED");
    expect(exec.source).toBe("webhook");
    expect(calls.sheets).toMatchObject({ id: "1SheetAbcDEFghij", range: "'Leads'!A1:append", body: { values: [["jane", "Hello, I want a demo", 9001]] } });
    expect(String((calls.sheets as { url: string }).url)).toContain("valueInputOption=USER_ENTERED");
    expect(calls.reply).toEqual({ chat_id: 9001, text: "Saved to Leads!A2:C2", reply_parameters: { message_id: 55 } });
    const steps = exec.steps as Array<{ stepId: string; status: string }>;
    expect(steps.map((s) => [s.stepId, s.status])).toEqual([["save", "succeeded"], ["reply", "succeeded"]]);

    // Same update delivered again (Telegram retries): acknowledged, not executed twice.
    const dup = await request(h.app).post(path).set("X-Telegram-Bot-Api-Secret-Token", webhook.secret_token).send(update(1001));
    expect(dup.body).toMatchObject({ accepted: 0, duplicates: 1 });
    await h.queue.drain();
    expect(await prisma.workflowExecution.count({ where: { workflowId } })).toBe(1);
  });

  it("rejects deliveries with a wrong secret or an unknown endpoint", async () => {
    const { webhook } = await setup();
    const path = new URL(webhook.url).pathname;
    expect((await request(h.app).post(path).set("X-Telegram-Bot-Api-Secret-Token", "wrong").send(update(1))).status).toBe(401);
    expect((await request(h.app).post("/webhooks/telegram/unknown-token").set("X-Telegram-Bot-Api-Secret-Token", webhook.secret_token).send(update(1))).status).toBe(404);
    expect(await prisma.webhookEvent.count()).toBe(0);
  });

  it("records a failed step, skips the rest and does not repeat succeeded steps on retry", async () => {
    const { workflowId, webhook } = await setup();
    let appends = 0;
    let replyFails = true;
    mockServer.use(
      http.post(`${SHEETS}/:id/values/:range`, () => {
        appends++;
        return HttpResponse.json({ updates: { updatedRange: "Leads!A2:C2", updatedRows: 1 } });
      }),
      http.post(`${TG}/sendMessage`, () => (replyFails ? HttpResponse.json({ ok: false, error_code: 400, description: "Bad Request: chat not found" }, { status: 400 }) : HttpResponse.json({ ok: true, result: { message_id: 1, date: 1, chat: { id: 9001, type: "private" } } }))),
    );
    await request(h.app).post(new URL(webhook.url).pathname).set("X-Telegram-Bot-Api-Secret-Token", webhook.secret_token).send(update(2002));
    await h.queue.drain();
    const failed = await prisma.workflowExecution.findFirstOrThrow({ where: { workflowId } });
    expect(failed.status).toBe("FAILED");
    expect(failed.error).toBe("reply: NOT_FOUND");

    // Simulate a resume of the same execution: the append must not run again.
    replyFails = false;
    await prisma.workflowExecution.update({ where: { id: failed.id }, data: { status: "RUNNING" } });
    await h.services.engine.run(failed.id);
    expect((await prisma.workflowExecution.findUniqueOrThrow({ where: { id: failed.id } })).status).toBe("SUCCEEDED");
    expect(appends).toBe(1);
  });

  it("can be tested manually from the builder with sample trigger data", async () => {
    const { workflowId } = await setup();
    mockServer.use(
      http.post(`${SHEETS}/:id/values/:range`, () => HttpResponse.json({ updates: { updatedRange: "Leads!A9:C9", updatedRows: 1 } })),
      http.post(`${TG}/sendMessage`, () => HttpResponse.json({ ok: true, result: { message_id: 1, date: 1, chat: { id: 1, type: "private" } } })),
    );
    const res = await owner.post(`/v1/workflows/${workflowId}/run`, { wait: true, triggerData: update(1).message && { ...update(1).message, chat: { id: 1 }, message_id: 1 } });
    expect(res.status).toBe(202);
    expect(res.body.status).toBe("SUCCEEDED");
    expect(res.body.source).toBe("test");
  });
});

describe("app-level webhooks (Slack) and per-connection (Stripe)", () => {
  function signed(body: string) {
    const ts = String(Math.floor(Date.now() / 1000));
    return { "X-Slack-Request-Timestamp": ts, "X-Slack-Signature": slackSignature("test-slack-signing", ts, body), "Content-Type": "application/json" };
  }

  it("answers the URL verification challenge", async () => {
    const body = JSON.stringify({ type: "url_verification", challenge: "abc123" });
    const res = await request(h.app).post("/webhooks/slack").set(signed(body)).send(body);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ challenge: "abc123" });
  });

  it("routes signed events by team id to the workspace's workflow", async () => {
    const slackConn = await seedOAuthConnection(h.services, owner, "slack", { accountId: "T0TEAM", expiresAt: null });
    const created = await owner.post("/v1/workflows", {
      name: "Slack echo",
      definition: { trigger: { connector: "slack", trigger: "new_message", connectionId: slackConn.id, config: {} }, steps: [{ id: "noop", connector: "http", action: "request", input: { url: "https://127.0.0.1/blocked" } }] },
    });
    await owner.post(`/v1/workflows/${created.body.id}/activate`);
    const body = JSON.stringify({ type: "event_callback", event_id: "Ev01", team_id: "T0TEAM", event: { type: "message", channel: "C1", user: "U1", text: "hi", ts: "1.2" } });
    const res = await request(h.app).post("/webhooks/slack").set(signed(body)).send(body);
    expect(res.body).toMatchObject({ accepted: 1 });
    await h.queue.drain();
    const exec = await prisma.workflowExecution.findFirstOrThrow({ where: { workflowId: created.body.id } });
    expect(exec.triggerData).toMatchObject({ channel: "C1", text: "hi" });
    // The HTTP step targets a loopback address: the SSRF guard blocks it.
    expect(exec.status).toBe("FAILED");
    expect(exec.error).toBe("noop: BLOCKED_DESTINATION");

    const unsigned = await request(h.app).post("/webhooks/slack").set("Content-Type", "application/json").send(body);
    expect(unsigned.status).toBe(401);
  });

  it("verifies Stripe events with the endpoint secret and dead-letters failures for replay", async () => {
    mockServer.use(http.get("https://api.stripe.com/v1/account", () => HttpResponse.json({ id: "acct_1", settings: { dashboard: { display_name: "Test shop" } } })));
    const conn = await owner.post("/v1/connections", { connector: "stripe", secret: "rk_test_not_real" });
    expect(conn.status).toBe(201);
    mockServer.use(http.post("https://api.stripe.com/v1/webhook_endpoints", () => HttpResponse.json({ id: "we_1", secret: "whsec_test" })));
    const wf = await owner.post("/v1/workflows", { name: "Paid", definition: { trigger: { connector: "stripe", trigger: "payment_succeeded", connectionId: conn.body.id, config: {} }, steps: [{ id: "get", connector: "stripe", action: "get_payment", connectionId: conn.body.id, input: { payment_intent_id: "{{trigger.payment_intent_id}}" } }] } });
    expect((await owner.post(`/v1/workflows/${wf.body.id}/activate`)).status).toBe(200);
    const sub = await prisma.webhookSubscription.findFirstOrThrow({ where: { provider: "stripe" } });
    expect(sub.externalId).toBe("we_1");
    expect(sub.signingSecret).not.toContain("whsec_test");

    const body = JSON.stringify({ id: "evt_1", type: "payment_intent.succeeded", data: { object: { id: "pi_1", amount: 1900, currency: "usd", status: "succeeded", customer: null, livemode: false } } });
    const path = `/webhooks/stripe/${sub.endpointToken}`;
    expect((await request(h.app).post(path).set({ "Stripe-Signature": stripeSignatureHeader("whsec_wrong", body), "Content-Type": "application/json" }).send(body)).status).toBe(401);

    // Make processing fail, then dead-letter and replay.
    const original = h.services.engine.dispatch.bind(h.services.engine);
    h.services.engine.dispatch = async () => { throw new Error("db unavailable"); };
    const ok = await request(h.app).post(path).set({ "Stripe-Signature": stripeSignatureHeader("whsec_test", body), "Content-Type": "application/json" }).send(body);
    expect(ok.status).toBe(200);
    await h.queue.drain();
    let event = await prisma.webhookEvent.findFirstOrThrow({ where: { provider: "stripe" } });
    expect(event.status).toBe("FAILED");
    await h.services.webhooks.markDead(event.id);
    expect((await prisma.webhookEvent.findUniqueOrThrow({ where: { id: event.id } })).status).toBe("DEAD");

    h.services.engine.dispatch = original;
    mockServer.use(http.get("https://api.stripe.com/v1/payment_intents/pi_1", () => HttpResponse.json({ id: "pi_1", amount: 1900, currency: "usd", status: "succeeded", customer: null, livemode: false })));
    expect((await owner.post(`/v1/webhook-events/${event.id}/replay`)).status).toBe(200);
    await h.queue.drain();
    event = await prisma.webhookEvent.findUniqueOrThrow({ where: { id: event.id } });
    expect(event.status).toBe("PROCESSED");
    const exec = await prisma.workflowExecution.findFirstOrThrow({ where: { workflowId: wf.body.id } });
    expect(exec.status).toBe("SUCCEEDED");
  });
});

describe("Shopify compliance webhooks", () => {
  it("verifies the HMAC and removes a redacted shop's credentials", async () => {
    const { shopifyWebhookHmac } = await import("../../src/integrations/providers/shopify.js");
    const conn = await seedOAuthConnection(h.services, owner, "shopify", { accountId: "demo.myshopify.com", expiresAt: null });
    const body = JSON.stringify({ shop_id: 1, shop_domain: "demo.myshopify.com" });
    const headers = { "Content-Type": "application/json", "X-Shopify-Topic": "shop/redact", "X-Shopify-Shop-Domain": "demo.myshopify.com" };
    expect((await request(h.app).post("/webhooks/shopify/compliance").set({ ...headers, "X-Shopify-Hmac-Sha256": "bad" }).send(body)).status).toBe(401);
    const ok = await request(h.app).post("/webhooks/shopify/compliance").set({ ...headers, "X-Shopify-Hmac-Sha256": shopifyWebhookHmac("test-shopify-secret", body) }).send(body);
    expect(ok.status).toBe(200);
    expect(await prisma.credential.count({ where: { connectionId: conn.id } })).toBe(0);
    expect((await prisma.connection.findUniqueOrThrow({ where: { id: conn.id } })).status).toBe("REVOKED");
  });
});

describe("polling triggers (Google Sheets new row)", () => {
  it("sets a baseline first, then starts one run per new row and saves the checkpoint", async () => {
    const sheets = await seedOAuthConnection(h.services, owner, "google-sheets");
    const tg = await connectTelegram();
    const wf = await owner.post("/v1/workflows", {
      name: "Notify on new lead",
      definition: {
        trigger: { connector: "google-sheets", trigger: "new_row", connectionId: sheets.id, config: { spreadsheet_id: "1PollSheetXYZabc", sheet: "Leads" } },
        steps: [{ id: "notify", connector: "telegram", action: "send_message", connectionId: tg.id, input: { chat_id: 1, text: "New lead: {{trigger.record.Name}}" } }],
      },
    });
    expect(wf.status).toBe(201);
    await owner.post(`/v1/workflows/${wf.body.id}/activate`);

    let rows = [["Name", "Email"], ["Ann", "ann@example.com"]];
    const sent: string[] = [];
    mockServer.use(
      http.get(`${SHEETS}/:id/values/:range`, () => HttpResponse.json({ values: rows })),
      http.post(`${TG}/sendMessage`, async ({ request }) => {
        sent.push(((await request.json()) as { text: string }).text);
        return HttpResponse.json({ ok: true, result: { message_id: 1, date: 1, chat: { id: 1, type: "private" } } });
      }),
    );

    await h.services.poller.poll(wf.body.id);
    expect(await prisma.workflowExecution.count()).toBe(0);
    rows = [...rows, ["Bob", "bob@example.com"], ["Cem", "cem@example.com"]];
    await h.services.poller.poll(wf.body.id);
    await h.queue.drain();
    expect(sent.sort()).toEqual(["New lead: Bob", "New lead: Cem"]);
    expect((await prisma.triggerState.findUniqueOrThrow({ where: { workflowId: wf.body.id } })).cursor).toEqual({ rowCount: 4 });

    // Polling again without changes starts nothing new.
    await h.services.poller.poll(wf.body.id);
    await h.queue.drain();
    expect(await prisma.workflowExecution.count()).toBe(2);
  });
});

describe("Telegram polling delivery (local development without a public URL)", () => {
  it("chooses polling for localhost and webhook for public HTTPS", async () => {
    const { telegramTriggerMode } = await import("../../src/integrations/providers/telegram.js");
    expect(telegramTriggerMode({ TELEGRAM_TRIGGER_MODE: "auto", PUBLIC_API_URL: "http://localhost:4000" })).toBe("polling");
    expect(telegramTriggerMode({ TELEGRAM_TRIGGER_MODE: "auto", PUBLIC_API_URL: "https://api.telzyra.com" })).toBe("webhook");
    expect(telegramTriggerMode({ TELEGRAM_TRIGGER_MODE: "polling", PUBLIC_API_URL: "https://api.telzyra.com" })).toBe("polling");
  });

  it("removes a leftover webhook, ignores stale updates on the first poll and advances the offset", async () => {
    const { telegram } = await import("../../src/integrations/providers/telegram.js");
    const conn = await connectTelegram();
    const now = Math.floor(Date.now() / 1000);
    let webhookSet = true;
    const offsets: unknown[] = [];
    mockServer.use(
      http.post(`${TG}/deleteWebhook`, () => {
        webhookSet = false;
        return HttpResponse.json({ ok: true, result: true });
      }),
      http.post(`${TG}/getUpdates`, async ({ request }) => {
        if (webhookSet) return HttpResponse.json({ ok: false, error_code: 409, description: "Conflict: can't use getUpdates method while webhook is active" }, { status: 409 });
        const body = (await request.json()) as { offset?: number };
        offsets.push(body.offset);
        const all = [
          { update_id: 10, message: { message_id: 1, date: now - 3600, text: "old", chat: { id: 5, type: "private" } } },
          { update_id: 11, message: { message_id: 2, date: now - 5, text: "fresh", chat: { id: 5, type: "private" }, from: { id: 5, is_bot: false, username: "u" } } },
        ];
        return HttpResponse.json({ ok: true, result: all.filter((u) => body.offset === undefined || u.update_id >= body.offset) });
      }),
    );
    const ctx = await h.services.runtime.context(owner.workspaceId, telegram, conn.id);
    const first = await telegram.triggers.new_message!.poll!(ctx, {}, undefined);
    expect(first.events.map((e) => (e.data as { text: string }).text)).toEqual(["fresh"]);
    expect(first.cursor).toEqual({ offset: 12 });
    const second = await telegram.triggers.new_message!.poll!(ctx, {}, first.cursor);
    expect(second.events).toEqual([]);
    expect(offsets).toEqual([undefined, 12]);
  });
});

describe("workflow validation", () => {
  it("rejects unknown actions, bad trigger config and foreign connections", async () => {
    const other = await signUp(h.app, "other");
    mockServer.use(telegramGetMe());
    const foreign = await other.post("/v1/connections", { connector: "telegram", secret: BOT_TOKEN });
    const res = await owner.post("/v1/workflows", {
      name: "Bad",
      definition: {
        trigger: { connector: "google-sheets", trigger: "new_row", connectionId: foreign.body.id, config: {} },
        steps: [{ id: "x", connector: "telegram", action: "launch_rocket", connectionId: foreign.body.id, input: {} }],
      },
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("workflow.invalid");
    const paths = res.body.issues.map((i: { path: string }) => i.path);
    expect(paths).toEqual(expect.arrayContaining(["trigger.config", "trigger.connectionId", "steps.0", "steps.0.connectionId"]));
  });
});
