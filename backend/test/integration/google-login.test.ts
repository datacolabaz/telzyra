import { http, HttpResponse } from "msw";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { GOOGLE_LOGIN_COOKIE } from "../../src/auth/google-login.js";
import { prisma, resetDb } from "../helpers/db.js";
import { mockServer } from "../helpers/integrations.js";

/**
 * "Continue with Google" — Google's token and userinfo endpoints are mocked (msw); everything on the
 * Telzyra side (state cookie, account matching, sessions, redirects) runs for real against Postgres.
 */

let app = createApp({ db: prisma, rateLimitMax: 50 });
const PROFILE = { sub: "google-sub-123", email: "Telman@Gmail.com", email_verified: true, name: "Telman Abdulla" };
let tokenRequests: URLSearchParams[] = [];

function useGoogle(profile: Record<string, unknown> = PROFILE, tokenStatus = 200) {
  mockServer.use(
    http.post("https://oauth2.googleapis.com/token", async ({ request }) => {
      tokenRequests.push(new URLSearchParams(await request.text()));
      return tokenStatus === 200 ? HttpResponse.json({ access_token: "ya29.test", id_token: "x", expires_in: 3600 }) : HttpResponse.json({ error: "invalid_grant" }, { status: tokenStatus });
    }),
    http.get("https://openidconnect.googleapis.com/v1/userinfo", ({ request }) =>
      request.headers.get("authorization") === "Bearer ya29.test" ? HttpResponse.json(profile) : HttpResponse.json({}, { status: 401 }),
    ),
  );
}

const cookies = (res: request.Response) => ([] as string[]).concat(res.headers["set-cookie"] ?? []);
const cookie = (res: request.Response, name: string) => cookies(res).find((c) => c.startsWith(`${name}=`))?.split(";")[0];

/** Runs /start and returns the state Google would echo back plus the browser's state cookie. */
async function start(locale = "az") {
  const res = await request(app).get(`/v1/auth/google/start?locale=${locale}`);
  expect(res.status).toBe(302);
  const url = new URL(res.headers.location);
  return { url, state: url.searchParams.get("state")!, stateCookie: cookie(res, GOOGLE_LOGIN_COOKIE)! };
}

async function callback(params: Record<string, string>, stateCookie?: string) {
  const req = request(app).get(`/v1/auth/google/callback?${new URLSearchParams(params)}`);
  return stateCookie ? req.set("Cookie", stateCookie) : req;
}

beforeAll(() => mockServer.listen({ onUnhandledRequest: "error" }));
afterEach(() => mockServer.resetHandlers());
afterAll(() => mockServer.close());
beforeEach(async () => {
  await resetDb();
  app = createApp({ db: prisma, rateLimitMax: 50 });
  tokenRequests = [];
});

describe("GET /v1/auth/providers", () => {
  it("reports Google sign-in as available when the client is configured", async () => {
    const res = await request(app).get("/v1/auth/providers");
    expect(res.body).toEqual({ google: true });
  });
});

describe("Continue with Google", () => {
  it("start: redirects to Google with PKCE, minimal scopes and an HttpOnly state cookie", async () => {
    const { url, stateCookie } = await start();
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(url.searchParams.get("scope")).toBe("openid email profile");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("redirect_uri")).toBe("https://api.test.telzyra.local/v1/auth/google/callback");
    expect(stateCookie).toBeTruthy();
    expect(stateCookie).not.toContain(url.searchParams.get("state")); // encrypted, not the raw state
  });

  it("new user: creates a verified, password-less account + workspace and signs in", async () => {
    useGoogle();
    const { state, stateCookie } = await start("az");
    const res = await callback({ code: "c1", state }, stateCookie);

    expect(res.status).toBe(303);
    expect(res.headers.location).toBe("http://localhost:3000/az/dashboard");
    expect(cookie(res, "tz_session")).toBeTruthy();
    expect(tokenRequests[0]!.get("code_verifier")).toBeTruthy();

    const user = await prisma.user.findUniqueOrThrow({ where: { email: "telman@gmail.com" }, include: { identities: true } });
    expect(user.passwordHash).toBeNull();
    expect(user.emailVerifiedAt).not.toBeNull();
    expect(user.locale).toBe("az");
    expect(user.identities).toMatchObject([{ provider: "google", subject: "google-sub-123" }]);
    expect(await prisma.membership.count({ where: { userId: user.id, role: "OWNER" } })).toBe(1);

    // The session works for the API, and nothing from Google is stored.
    const me = await request(app).get("/v1/auth/me").set("Cookie", cookie(res, "tz_session")!);
    expect(me.body.user).toMatchObject({ email: "telman@gmail.com", emailVerified: true });
    expect(JSON.stringify(await prisma.user.findMany())).not.toContain("ya29.test");
  });

  it("returning user: signs into the same account, no duplicates", async () => {
    useGoogle();
    let s = await start();
    await callback({ code: "c1", state: s.state }, s.stateCookie);
    s = await start();
    const res = await callback({ code: "c2", state: s.state }, s.stateCookie);
    expect(res.status).toBe(303);
    expect(await prisma.user.count()).toBe(1);
    expect(await prisma.workspace.count()).toBe(1);
  });

  it("existing verified password account: links Google and keeps the password", async () => {
    const reg = await request(app).post("/v1/auth/register").send({ name: "Telman", email: "telman@gmail.com", password: "correct-horse-1" });
    await prisma.user.update({ where: { id: reg.body.user.id }, data: { emailVerifiedAt: new Date() } });
    useGoogle();
    const s = await start();
    const res = await callback({ code: "c1", state: s.state }, s.stateCookie);
    expect(res.status).toBe(303);
    const user = await prisma.user.findUniqueOrThrow({ where: { id: reg.body.user.id }, include: { identities: true } });
    expect(user.passwordHash).not.toBeNull();
    expect(user.identities).toHaveLength(1);
    const login = await request(app).post("/v1/auth/login").send({ email: "telman@gmail.com", password: "correct-horse-1" });
    expect(login.status).toBe(200);
  });

  it("existing UNverified account (possible pre-hijack): password removed and its sessions revoked on link", async () => {
    const squatter = await request(app).post("/v1/auth/register").send({ name: "Someone", email: "telman@gmail.com", password: "squatter-pass-1" });
    const squatterCookie = cookie(squatter, "tz_session")!;
    useGoogle();
    const s = await start();
    const res = await callback({ code: "c1", state: s.state }, s.stateCookie);
    expect(res.status).toBe(303);

    const user = await prisma.user.findUniqueOrThrow({ where: { email: "telman@gmail.com" } });
    expect(user.passwordHash).toBeNull();
    expect(user.emailVerifiedAt).not.toBeNull();
    expect((await request(app).get("/v1/auth/me").set("Cookie", squatterCookie)).status).toBe(401);
    expect((await request(app).post("/v1/auth/login").send({ email: "telman@gmail.com", password: "squatter-pass-1" })).status).toBe(401);
  });

  it("password login for a Google-only account fails like a wrong password", async () => {
    useGoogle();
    const s = await start();
    await callback({ code: "c1", state: s.state }, s.stateCookie);
    const res = await request(app).post("/v1/auth/login").send({ email: "telman@gmail.com", password: "anything-123" });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe("auth.invalid_credentials");
  });

  it("rejects a callback without the state cookie (CSRF / login injection)", async () => {
    useGoogle();
    const { state } = await start();
    const res = await callback({ code: "c1", state });
    expect(res.headers.location).toBe("http://localhost:3000/login?error=google_invalid_state");
    expect(tokenRequests).toHaveLength(0);
    expect(await prisma.user.count()).toBe(0);
  });

  it("rejects a state that does not match the cookie", async () => {
    useGoogle();
    const { stateCookie } = await start();
    const res = await callback({ code: "c1", state: "forged" }, stateCookie);
    expect(res.headers.location).toContain("error=google_invalid_state");
    expect(tokenRequests).toHaveLength(0);
  });

  it("rejects an email Google has not verified", async () => {
    useGoogle({ ...PROFILE, email_verified: false });
    const s = await start("en");
    const res = await callback({ code: "c1", state: s.state }, s.stateCookie);
    expect(res.headers.location).toBe("http://localhost:3000/login?error=google_email_unverified");
    expect(await prisma.user.count()).toBe(0);
  });

  it("user cancelled on Google → back to login with google_denied", async () => {
    const s = await start("ru");
    const res = await callback({ error: "access_denied", state: s.state }, s.stateCookie);
    expect(res.headers.location).toBe("http://localhost:3000/ru/login?error=google_denied");
  });

  it("never redirects off-site through the locale parameter (open redirect)", async () => {
    const saved = process.env.GOOGLE_CLIENT_ID;
    const res = await request(app).get("/v1/auth/google/start?locale=%2Fevil.example");
    const target = new URL(res.headers.location);
    expect(["accounts.google.com", "localhost"]).toContain(target.hostname);
    expect(process.env.GOOGLE_CLIENT_ID).toBe(saved);
  });

  it("token exchange failure → google_exchange_failed, no account", async () => {
    useGoogle(PROFILE, 400);
    const s = await start("en");
    const res = await callback({ code: "bad", state: s.state }, s.stateCookie);
    expect(res.headers.location).toBe("http://localhost:3000/login?error=google_exchange_failed");
    expect(await prisma.user.count()).toBe(0);
  });
});
