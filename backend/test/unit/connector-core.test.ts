import { http, HttpResponse } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { CircuitBreaker } from "../../src/integrations/core/circuit-breaker.js";
import { ConnectorError } from "../../src/integrations/core/errors.js";
import { HttpClient, parseRetryAfter } from "../../src/integrations/core/http.js";
import { assertPublicUrl, isBlockedAddress } from "../../src/integrations/core/ssrf.js";
import { resolveTemplates } from "../../src/workflows/templates.js";
import { mockServer } from "../helpers/integrations.js";

beforeAll(() => mockServer.listen({ onUnhandledRequest: "error" }));
afterEach(() => mockServer.resetHandlers());
afterAll(() => mockServer.close());

const URL_ = "https://api.example.test/thing";
function client(breaker = new CircuitBreaker(3, 60_000), maxDelayMs = 100) {
  const sleeps: number[] = [];
  const c = new HttpClient({ provider: "test", breakerKey: "test:1", baseDelayMs: 10, maxDelayMs, sleep: async (ms) => void sleeps.push(ms) }, breaker);
  return { c, sleeps, breaker };
}

describe("HttpClient", () => {
  it("retries 5xx on idempotent requests with jittered backoff", async () => {
    let calls = 0;
    mockServer.use(http.get(URL_, () => (++calls < 3 ? new HttpResponse(null, { status: 503 }) : HttpResponse.json({ ok: 1 }))));
    const { c, sleeps } = client();
    const res = await c.request({ url: URL_ });
    expect(res.data).toEqual({ ok: 1 });
    expect(calls).toBe(3);
    expect(sleeps).toHaveLength(2);
    sleeps.forEach((s) => expect(s).toBeLessThanOrEqual(100));
  });

  it("honours Retry-After on 429", async () => {
    let calls = 0;
    mockServer.use(http.post(URL_, () => (++calls === 1 ? new HttpResponse(null, { status: 429, headers: { "Retry-After": "2" } }) : HttpResponse.json({ ok: 1 }))));
    const { c, sleeps } = client(new CircuitBreaker(), 60_000);
    await c.request({ method: "POST", url: URL_, json: {} });
    expect(sleeps[0]).toBe(2000);
    // Retry-After is capped by maxDelayMs so one job cannot block a worker indefinitely.
    calls = 0;
    const capped = client(new CircuitBreaker(), 500);
    await capped.c.request({ method: "POST", url: URL_, json: {} });
    expect(capped.sleeps[0]).toBe(500);
  });

  it("does not retry a non-idempotent POST on 5xx, but does with an idempotency key", async () => {
    let calls = 0;
    mockServer.use(http.post(URL_, ({ request }) => {
      calls++;
      return request.headers.get("idempotency-key") && calls > 1 ? HttpResponse.json({ ok: 1 }) : new HttpResponse(null, { status: 500 });
    }));
    const { c } = client();
    await expect(c.request({ method: "POST", url: URL_, json: {} })).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
    expect(calls).toBe(1);
    calls = 0;
    const res = await c.request({ method: "POST", url: URL_, json: {}, idempotencyKey: "k-1" });
    expect(res.status).toBe(200);
  });

  it("maps 401/403/404 without retrying", async () => {
    mockServer.use(http.get(URL_, () => new HttpResponse(null, { status: 404 })));
    const { c, sleeps } = client();
    await expect(c.request({ url: URL_ })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(sleeps).toHaveLength(0);
  });

  it("opens the circuit after repeated provider failures", async () => {
    mockServer.use(http.get(URL_, () => new HttpResponse(null, { status: 502 })));
    const { c } = client(new CircuitBreaker(3, 60_000));
    await expect(c.request({ url: URL_, maxRetries: 0 })).rejects.toBeInstanceOf(ConnectorError);
    await expect(c.request({ url: URL_, maxRetries: 0 })).rejects.toBeInstanceOf(ConnectorError);
    await expect(c.request({ url: URL_, maxRetries: 0 })).rejects.toBeInstanceOf(ConnectorError);
    await expect(c.request({ url: URL_, maxRetries: 0 })).rejects.toMatchObject({ code: "CIRCUIT_OPEN" });
  });

  it("times out slow requests", async () => {
    mockServer.use(http.get(URL_, async () => { await new Promise((r) => setTimeout(r, 300)); return HttpResponse.json({}); }));
    const { c } = client();
    await expect(c.request({ url: URL_, timeoutMs: 50, maxRetries: 0 })).rejects.toMatchObject({ code: "TIMEOUT" });
  });

  it("parses Retry-After seconds and dates", () => {
    expect(parseRetryAfter("3")).toBe(3000);
    expect(parseRetryAfter(new Date(Date.now() + 5000).toUTCString())).toBeGreaterThan(3000);
    expect(parseRetryAfter(null)).toBeUndefined();
  });
});

describe("SSRF guard", () => {
  it("blocks private, loopback, link-local and metadata addresses", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "::1", "fd00::1", "::ffff:127.0.0.1", "0.0.0.0"]) expect(isBlockedAddress(ip), ip).toBe(true);
    for (const ip of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"]) expect(isBlockedAddress(ip), ip).toBe(false);
  });

  it("rejects non-http schemes, odd ports, credentials and internal hosts", async () => {
    const pub = async () => ["93.184.216.34"];
    await expect(assertPublicUrl("file:///etc/passwd", pub)).rejects.toMatchObject({ code: "BLOCKED_DESTINATION" });
    await expect(assertPublicUrl("http://example.com:6379/", pub)).rejects.toMatchObject({ code: "BLOCKED_DESTINATION" });
    await expect(assertPublicUrl("https://user:pw@example.com/", pub)).rejects.toMatchObject({ code: "BLOCKED_DESTINATION" });
    await expect(assertPublicUrl("http://localhost/", pub)).rejects.toMatchObject({ code: "BLOCKED_DESTINATION" });
    await expect(assertPublicUrl("https://rebind.example/", async () => ["10.0.0.5"])).rejects.toMatchObject({ code: "BLOCKED_DESTINATION" });
    await expect(assertPublicUrl("https://example.com/x", pub)).resolves.toBeInstanceOf(URL);
  });
});

describe("templates", () => {
  const scope = { trigger: { chat: { id: 42 }, text: "hi", items: [{ n: 1 }] }, steps: { a: { range: "Sheet1!A2:B2" } } };
  it("keeps the type of a single-template value and interpolates text", () => {
    expect(resolveTemplates({ chat_id: "{{trigger.chat.id}}", text: "Saved {{ steps.a.range }} ({{trigger.text}})", first: "{{trigger.items[0].n}}" }, scope)).toEqual({ chat_id: 42, text: "Saved Sheet1!A2:B2 (hi)", first: 1 });
  });
  it("cannot reach prototypes", () => {
    expect(resolveTemplates("{{trigger.__proto__}}", scope)).toBeUndefined();
    expect(resolveTemplates("{{trigger.constructor.name}}", scope)).toBeUndefined();
    expect(resolveTemplates({ __proto__: { x: 1 }, ok: 1 } as unknown, scope)).toEqual({ ok: 1 });
  });
  it("renders missing values as empty strings in text", () => {
    expect(resolveTemplates("x={{trigger.nope}}", scope)).toBe("x=");
  });
});
