import { createHmac } from "node:crypto";
import { http, HttpResponse } from "msw";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { igTiming } from "../../src/integrations/providers/instagram.js";
import { prisma, resetDb } from "../helpers/db.js";
import { harness, mockServer, seedOAuthConnection, signUp, type Agent, type Harness } from "../helpers/integrations.js";

const G = "https://graph.facebook.com/v27.0";
const proof = (t: string) => createHmac("sha256", "test-meta-secret").update(t).digest("hex");
const PAGE = { id: "1234567890", name: "Telzyra Test Page", category: "Software", tasks: ["CREATE_CONTENT", "MANAGE"], access_token: "PAGE-TOKEN-SECRET", instagram_business_account: { id: "17841400000000001", username: "telzyra.test" } };

beforeAll(() => mockServer.listen({ onUnhandledRequest: "error" }));
afterEach(() => mockServer.resetHandlers());
afterAll(() => mockServer.close());

let h: Harness;
let owner: Agent;
beforeEach(async () => {
  await resetDb();
  h = harness();
  owner = await signUp(h.app, "meta");
  igTiming.intervalMs = 1;
  igTiming.maxWaitMs = 200;
});

const accounts = () => http.get(`${G}/me/accounts`, ({ request }) => {
  const u = new URL(request.url);
  expect(u.searchParams.get("appsecret_proof")).toBe(proof(u.searchParams.get("access_token")!));
  return HttpResponse.json({ data: [PAGE] });
});
const step = (connector: string, action: string, connectionId: string, input: unknown) => owner.post("/v1/workflows/test-step", { connector, action, connectionId, input });

describe("Meta OAuth (Facebook Login for Business)", () => {
  it("exchanges the code for a long-lived token and records only granted permissions", async () => {
    const start = await owner.post("/v1/oauth/instagram/start", {});
    const url = new URL(start.body.url);
    expect(url.origin + url.pathname).toBe("https://www.facebook.com/v27.0/dialog/oauth");
    expect(url.searchParams.get("scope")).toBe("instagram_basic,instagram_content_publish,pages_show_list,pages_read_engagement,business_management");
    expect(url.searchParams.get("redirect_uri")).toBe("https://api.test.telzyra.local/v1/oauth/meta/callback");
    const calls: string[] = [];
    mockServer.use(
      http.get(`${G}/oauth/access_token`, ({ request }) => {
        const q = new URL(request.url).searchParams;
        calls.push(q.get("grant_type") ?? "code");
        return q.get("grant_type") === "fb_exchange_token" ? HttpResponse.json({ access_token: "LONG-USER-TOKEN", expires_in: 5183944 }) : HttpResponse.json({ access_token: "SHORT", expires_in: 3600 });
      }),
      http.get(`${G}/me/permissions`, () => HttpResponse.json({ data: ["instagram_basic", "instagram_content_publish", "pages_show_list", "pages_read_engagement", "business_management"].map((permission) => ({ permission, status: "granted" })) })),
      http.get(`${G}/me`, () => HttpResponse.json({ id: "999", name: "Telman" })),
    );
    const cb = await request(h.app).get(`/v1/oauth/meta/callback?state=${url.searchParams.get("state")}&code=abc`).set("Cookie", owner.cookie);
    expect(cb.headers.location).toContain("status=connected");
    expect(calls).toEqual(["code", "fb_exchange_token"]);
    const conn = await prisma.connection.findFirstOrThrow({ where: { provider: "instagram" }, include: { credential: true } });
    expect(conn.externalAccountId).toBe("999");
    expect(conn.credential!.accessTokenExpiresAt!.getTime()).toBeGreaterThan(Date.now() + 59 * 86_400_000);
    expect(conn.credential!.secret).not.toContain("LONG-USER-TOKEN");
  });

  it("rejects the connection when the user unticks a required permission", async () => {
    const start = await owner.post("/v1/oauth/facebook-pages/start", {});
    const state = new URL(start.body.url).searchParams.get("state");
    mockServer.use(
      http.get(`${G}/oauth/access_token`, () => HttpResponse.json({ access_token: "T", expires_in: 5000000 })),
      http.get(`${G}/me/permissions`, () => HttpResponse.json({ data: [{ permission: "pages_show_list", status: "granted" }, { permission: "pages_manage_posts", status: "declined" }, { permission: "pages_read_engagement", status: "granted" }, { permission: "business_management", status: "granted" }] })),
      http.get(`${G}/me`, () => HttpResponse.json({ id: "999", name: "Telman" })),
    );
    const cb = await request(h.app).get(`/v1/oauth/meta/callback?state=${state}&code=abc`).set("Cookie", owner.cookie);
    expect(cb.headers.location).toContain("reason=oauth.scopes_missing");
    expect(await prisma.connection.count()).toBe(0);
  });
});

describe("Facebook Pages", () => {
  it("lists pages without exposing page tokens and posts with the page token", async () => {
    const conn = await seedOAuthConnection(h.services, owner, "facebook-pages", { accessToken: "USER-TOKEN", refreshToken: undefined as never, expiresAt: new Date(Date.now() + 86_400_000) });
    let posted: URLSearchParams | undefined;
    mockServer.use(
      accounts(),
      http.post(`${G}/${PAGE.id}/feed`, async ({ request }) => {
        posted = new URLSearchParams(await request.text());
        return HttpResponse.json({ id: `${PAGE.id}_555` });
      }),
    );
    const list = await step("facebook-pages", "list_pages", conn.id, {});
    expect(list.body.ok).toBe(true);
    expect(JSON.stringify(list.body)).not.toContain("PAGE-TOKEN-SECRET");
    expect(list.body.output.pages[0]).toMatchObject({ page_id: PAGE.id, can_post: true, instagram: { ig_user_id: PAGE.instagram_business_account.id } });

    const post = await step("facebook-pages", "create_post", conn.id, { page_id: PAGE.id, message: "Salam!" });
    expect(post.body).toMatchObject({ ok: true, output: { post_id: `${PAGE.id}_555`, scheduled: false } });
    expect(posted!.get("access_token")).toBe("PAGE-TOKEN-SECRET");
    expect(posted!.get("appsecret_proof")).toBe(proof("PAGE-TOKEN-SECRET"));
    expect(JSON.stringify(post.body)).not.toContain("PAGE-TOKEN-SECRET");
  });

  it("validates scheduling windows and maps expired tokens", async () => {
    const conn = await seedOAuthConnection(h.services, owner, "facebook-pages", { accessToken: "USER-TOKEN", refreshToken: undefined as never });
    const tooSoon = await step("facebook-pages", "create_post", conn.id, { page_id: PAGE.id, message: "x", scheduled_at: new Date(Date.now() + 60_000).toISOString() });
    expect(tooSoon.body.error.code).toBe("VALIDATION");
    mockServer.use(http.get(`${G}/me/accounts`, () => HttpResponse.json({ error: { message: "Error validating access token: Session has expired", type: "OAuthException", code: 190, error_subcode: 463 } }, { status: 400 })));
    const expired = await step("facebook-pages", "list_pages", conn.id, {});
    expect(expired.body.error.code).toBe("AUTH_EXPIRED");
    expect((await prisma.connection.findUniqueOrThrow({ where: { id: conn.id } })).status).toBe("EXPIRED");
  });
});

describe("Instagram publishing", () => {
  const IG = PAGE.instagram_business_account.id;

  it("checks quota, waits for the container and publishes", async () => {
    const conn = await seedOAuthConnection(h.services, owner, "instagram", { accessToken: "USER-TOKEN", refreshToken: undefined as never });
    let polls = 0;
    const created: Record<string, string>[] = [];
    mockServer.use(
      accounts(),
      http.get(`${G}/${IG}/content_publishing_limit`, () => HttpResponse.json({ data: [{ quota_usage: 3, config: { quota_total: 100, quota_duration: 86400 } }] })),
      http.post(`${G}/${IG}/media`, async ({ request }) => {
        created.push(Object.fromEntries(new URLSearchParams(await request.text())));
        return HttpResponse.json({ id: "C1" });
      }),
      http.get(`${G}/C1`, () => HttpResponse.json({ status_code: ++polls < 3 ? "IN_PROGRESS" : "FINISHED" })),
      http.post(`${G}/${IG}/media_publish`, () => HttpResponse.json({ id: "M1" })),
      http.get(`${G}/M1`, () => HttpResponse.json({ id: "M1", permalink: "https://www.instagram.com/p/abc/" })),
    );
    const r = await step("instagram", "publish_image", conn.id, { ig_user_id: IG, image_url: "https://cdn.example.com/a.jpg", caption: "Salam" });
    expect(r.body).toMatchObject({ ok: true, output: { media_id: "M1", permalink: "https://www.instagram.com/p/abc/" } });
    expect(polls).toBe(3);
    expect(created[0]).toMatchObject({ image_url: "https://cdn.example.com/a.jpg", caption: "Salam", access_token: "PAGE-TOKEN-SECRET" });
  });

  it("refuses to publish when the 24h quota is used up, before creating a container", async () => {
    const conn = await seedOAuthConnection(h.services, owner, "instagram", { accessToken: "USER-TOKEN", refreshToken: undefined as never });
    let containers = 0;
    mockServer.use(
      accounts(),
      http.get(`${G}/${IG}/content_publishing_limit`, () => HttpResponse.json({ data: [{ quota_usage: 100, config: { quota_total: 100 } }] })),
      http.post(`${G}/${IG}/media`, () => { containers++; return HttpResponse.json({ id: "X" }); }),
    );
    const r = await step("instagram", "publish_image", conn.id, { ig_user_id: IG, image_url: "https://cdn.example.com/a.jpg" });
    expect(r.body.error.code).toBe("RATE_LIMITED");
    expect(containers).toBe(0);
  });

  it("reports processing errors and rejects non-https media", async () => {
    const conn = await seedOAuthConnection(h.services, owner, "instagram", { accessToken: "USER-TOKEN", refreshToken: undefined as never });
    mockServer.use(
      accounts(),
      http.get(`${G}/${IG}/content_publishing_limit`, () => HttpResponse.json({ data: [{ quota_usage: 0, config: { quota_total: 100 } }] })),
      http.post(`${G}/${IG}/media`, () => HttpResponse.json({ id: "C9" })),
      http.get(`${G}/C9`, () => HttpResponse.json({ status_code: "ERROR", status: "Error: MediaType not supported" })),
    );
    const bad = await step("instagram", "publish_reel", conn.id, { ig_user_id: IG, video_url: "https://cdn.example.com/v.mov" });
    expect(bad.body.error).toMatchObject({ code: "VALIDATION" });
    expect(bad.body.error.message).toContain("ERROR");
    const insecure = await step("instagram", "publish_image", conn.id, { ig_user_id: IG, image_url: "http://cdn.example.com/a.jpg" });
    expect(insecure.body.error.code).toBe("VALIDATION");
  });

  it("publishes a carousel from children containers", async () => {
    const conn = await seedOAuthConnection(h.services, owner, "instagram", { accessToken: "USER-TOKEN", refreshToken: undefined as never });
    let n = 0;
    let carouselParams: URLSearchParams | undefined;
    mockServer.use(
      accounts(),
      http.get(`${G}/${IG}/content_publishing_limit`, () => HttpResponse.json({ data: [{ quota_usage: 0, config: { quota_total: 100 } }] })),
      http.post(`${G}/${IG}/media`, async ({ request }) => {
        const p = new URLSearchParams(await request.text());
        if (p.get("media_type") === "CAROUSEL") { carouselParams = p; return HttpResponse.json({ id: "CAR" }); }
        expect(p.get("is_carousel_item")).toBe("true");
        return HttpResponse.json({ id: `CH${++n}` });
      }),
      http.get(`${G}/:id`, ({ params }) => HttpResponse.json(String(params.id) === "M2" ? { id: "M2", permalink: "https://www.instagram.com/p/car/" } : { status_code: "FINISHED" })),
      http.post(`${G}/${IG}/media_publish`, () => HttpResponse.json({ id: "M2" })),
    );
    const r = await step("instagram", "publish_carousel", conn.id, { ig_user_id: IG, image_urls: ["https://a.example/1.jpg", "https://a.example/2.jpg", "https://a.example/3.jpg"], caption: "3 şəkil" });
    expect(r.body).toMatchObject({ ok: true, output: { media_id: "M2", items: 3 } });
    expect(carouselParams!.get("children")).toBe("CH1,CH2,CH3");
  });
});
