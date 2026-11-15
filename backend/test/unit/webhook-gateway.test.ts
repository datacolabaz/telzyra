import { spawn, type ChildProcess } from "node:child_process";
import http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let upstream: http.Server;
let gw: ChildProcess;
const hits: Array<{ path: string; cookie: string | null }> = [];

beforeAll(async () => {
  upstream = http.createServer((req, res) => {
    hits.push({ path: req.url ?? "", cookie: req.headers.cookie ?? null });
    res.writeHead(200, { "content-type": "application/json" }).end("{}");
  });
  await new Promise<void>((r) => upstream.listen(4710, "127.0.0.1", r));
  gw = spawn("node", ["scripts/webhook-gateway.mjs", "4711", "http://127.0.0.1:4710", "http://localhost:4000"], { stdio: "ignore" });
  await new Promise((r) => setTimeout(r, 700));
});
afterAll(() => {
  gw.kill();
  upstream.close();
});

const call = (method: string, path: string, headers: Record<string, string> = {}) => fetch(`http://127.0.0.1:4711${path}`, { method, headers, redirect: "manual", body: method === "POST" ? "{}" : undefined });

describe("webhook gateway (what an HTTPS tunnel exposes)", () => {
  it("forwards webhook POSTs without cookies", async () => {
    const r = await call("POST", "/webhooks/slack", { cookie: "tz_session=stolen" });
    expect(r.status).toBe(200);
    expect(hits.at(-1)).toEqual({ path: "/webhooks/slack", cookie: null });
  });

  it("blocks the API, sessions and OAuth start", async () => {
    const before = hits.length;
    for (const [m, p] of [["GET", "/v1/connections"], ["POST", "/v1/auth/login"], ["POST", "/v1/oauth/slack/start"], ["GET", "/dashboard"], ["GET", "/webhooks/slack"]] as const) {
      expect((await call(m, p)).status, `${m} ${p}`).toBe(404);
    }
    expect(hits.length).toBe(before);
  });

  it("bounces https OAuth callbacks to the local API without contacting it", async () => {
    const before = hits.length;
    const r = await call("GET", "/v1/oauth/slack/callback?code=abc&state=xyz");
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toBe("http://localhost:4000/v1/oauth/slack/callback?code=abc&state=xyz");
    expect(r.headers.get("referrer-policy")).toBe("no-referrer");
    expect(hits.length).toBe(before);
  });
});
