import request from "supertest";
import { setupServer } from "msw/node";
import { createApp } from "../../src/app.js";
import { cipher } from "../../src/db/client.js";
import { createServices, jobHandlers, type Services } from "../../src/container.js";
import { InlineQueue } from "../../src/queue/queue.js";
import { sharedBreaker } from "../../src/integrations/core/http.js";
import { prisma } from "./db.js";

/** Intercepts all outbound provider HTTP. Unhandled requests fail the test (no real network). */
export const mockServer = setupServer();

export interface Harness {
  app: ReturnType<typeof createApp>;
  services: Services;
  queue: InlineQueue;
}

export function harness(): Harness {
  const queue = new InlineQueue();
  const services = createServices(prisma, cipher, queue, { http: { baseDelayMs: 1, maxDelayMs: 5, sleep: async () => undefined } });
  queue.setHandlers(jobHandlers(services));
  // Reset circuit breakers between tests.
  sharedBreaker.reset();
  return { app: createApp({ db: prisma, services }), services, queue };
}

export interface Agent {
  cookie: string;
  csrf: string;
  userId: string;
  workspaceId: string;
  get(url: string): request.Test;
  post(url: string, body?: unknown): request.Test;
  patch(url: string, body?: unknown): request.Test;
  del(url: string): request.Test;
}

let n = 0;
export async function signUp(app: Harness["app"], label = "user"): Promise<Agent> {
  n++;
  const res = await request(app).post("/v1/auth/register").send({ name: `${label} name`, email: `${label}${n}@example.com`, password: "correct-horse-1", locale: "en" });
  if (res.status !== 201) throw new Error(`register failed ${res.status}`);
  const cookie = ([] as string[]).concat(res.headers["set-cookie"] ?? []).find((c) => c.startsWith("tz_session="))!.split(";")[0]!;
  const csrf = res.body.csrfToken as string;
  const with_ = (t: request.Test) => t.set("Cookie", cookie).set("x-csrf-token", csrf);
  return {
    cookie,
    csrf,
    userId: res.body.user.id,
    workspaceId: res.body.workspace.id,
    get: (url) => request(app).get(url).set("Cookie", cookie),
    post: (url, body) => with_(request(app).post(url)).send(body as object),
    patch: (url, body) => with_(request(app).patch(url)).send(body as object),
    del: (url) => with_(request(app).delete(url)),
  };
}

/** Creates an OAuth connection with stored (encrypted) tokens, as a successful OAuth callback would. */
export async function seedOAuthConnection(s: Services, a: Agent, provider: string, opts: { accessToken?: string; refreshToken?: string; expiresAt?: Date | null; accountId?: string } = {}) {
  const conn = await prisma.connection.create({
    data: { workspaceId: a.workspaceId, provider, authType: "OAUTH2", displayName: `${provider} test`, externalAccountId: opts.accountId ?? `${provider}-acct`, scopes: [], createdById: a.userId },
  });
  await s.credentials.save(prisma, conn, { accessToken: opts.accessToken ?? "access-1", refreshToken: opts.refreshToken ?? "refresh-1" }, opts.expiresAt === undefined ? new Date(Date.now() + 3600_000) : opts.expiresAt);
  return conn;
}
