/**
 * Backend for browser E2E tests: the real Telzyra API, pg-boss workers and Postgres, with outbound
 * provider HTTP answered by stateful fakes (msw). A small control API on E2E_CONTROL_PORT lets the
 * browser test act as "the outside world" (a Telegram user writing to the bot) and inspect results.
 *
 * Refuses to start unless NODE_ENV=test and the database name contains "e2e".
 */
import { createServer } from "node:http";
import { setupServer } from "msw/node";
import { env } from "../../src/config/env.js";
import { logger } from "../../src/lib/logger.js";
import { cipher, prisma } from "../../src/db/client.js";
import { createApp } from "../../src/app.js";
import { createServices, jobHandlers } from "../../src/container.js";
import { PgBossQueue } from "../../src/queue/queue.js";
import { createFakeState, fakeProviderHandlers, pushTelegramMessage } from "./fake-providers.js";

if (env.NODE_ENV !== "test" || !/e2e/.test(new URL(env.DATABASE_URL).pathname)) {
  throw new Error("E2E server requires NODE_ENV=test and an *e2e* database");
}

let state = createFakeState();
const mock = setupServer(...fakeProviderHandlers(state));
mock.listen({ onUnhandledRequest: "error" });

const queue = new PgBossQueue(env.DATABASE_URL);
const services = createServices(prisma, cipher, queue);
await queue.start(jobHandlers(services), true);
createApp({ db: prisma, services }).listen(env.PORT, "127.0.0.1", () => logger.info({ port: env.PORT }, "e2e api listening"));

const json = (res: import("node:http").ServerResponse, code: number, body: unknown) => {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
};
createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
  try {
    if (req.method === "POST" && req.url === "/reset") {
      state = createFakeState();
      mock.resetHandlers(...fakeProviderHandlers(state));
      return json(res, 200, { ok: true });
    }
    if (req.method === "POST" && req.url === "/google/code") {
      const code = `e2e-code-${Math.random().toString(36).slice(2)}`;
      state.google.codes.add(code);
      return json(res, 200, { code });
    }
    if (req.method === "POST" && req.url === "/telegram/incoming") return json(res, 200, { updateId: pushTelegramMessage(state, body) });
    if (req.method === "POST" && req.url === "/poll-now") {
      // Polls every active polling workflow immediately (the scheduler would do it within its interval).
      const due = await prisma.triggerState.findMany({ where: { workflow: { status: "ACTIVE" } }, select: { workflowId: true } });
      for (const d of due) await services.poller.poll(d.workflowId);
      return json(res, 200, { polled: due.length });
    }
    if (req.method === "GET" && req.url === "/state") return json(res, 200, { telegram: { webhookUrl: state.telegram.webhookUrl, pending: state.telegram.pending.length, sent: state.telegram.sent }, google: { sheets: state.google.sheets, refreshCount: state.google.refreshCount } });
    json(res, 404, {});
  } catch (err) {
    json(res, 500, { error: err instanceof Error ? err.message : "error" });
  }
}).listen(Number(process.env.E2E_CONTROL_PORT ?? 4999), "127.0.0.1");
