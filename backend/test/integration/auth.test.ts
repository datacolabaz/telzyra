import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { prisma, resetDb } from "../helpers/db.js";

// A fresh app per test gives every test its own rate-limiter state.
let app = createApp({ db: prisma, rateLimitMax: 5 });
const USER = { name: "Telman Abdulla", email: "Telman@Example.com", password: "correct-horse-1", locale: "az" };

async function register(body: Record<string, unknown> = USER) {
  return request(app).post("/v1/auth/register").send(body);
}

function sessionCookie(res: request.Response): string {
  const cookies = ([] as string[]).concat(res.headers["set-cookie"] ?? []);
  const c = cookies.find((x) => x.startsWith("tz_session="));
  if (!c) throw new Error("no session cookie");
  return c.split(";")[0]!;
}

beforeEach(async () => {
  await resetDb();
  app = createApp({ db: prisma, rateLimitMax: 5 });
});

describe("POST /v1/auth/register", () => {
  it("creates user, owner workspace and an HttpOnly session", async () => {
    const res = await register();
    expect(res.status).toBe(201);
    expect(res.body.user).toMatchObject({ email: "telman@example.com", name: "Telman Abdulla", locale: "az", emailVerified: false });
    expect(res.body.role).toBe("OWNER");
    expect(res.body.csrfToken).toEqual(expect.any(String));
    expect(res.body.user.passwordHash).toBeUndefined();

    const cookie = ([] as string[]).concat(res.headers["set-cookie"]).find((c) => c.startsWith("tz_session="))!;
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);

    const user = await prisma.user.findUniqueOrThrow({ where: { email: "telman@example.com" } });
    expect(user.passwordHash.startsWith("$argon2id$")).toBe(true);
    expect(await prisma.membership.count({ where: { userId: user.id, role: "OWNER" } })).toBe(1);

    const session = await prisma.session.findFirstOrThrow({ where: { userId: user.id } });
    expect(sessionCookie(res)).not.toContain(session.tokenHash); // only the hash is stored
  });

  it("returns localizable validation codes", async () => {
    const res = await register({ name: "T", email: "nope", password: "short" });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      code: "validation",
      fields: {
        name: { code: "nameMin", params: { min: 2 } },
        email: { code: "email" },
        password: { code: "passwordMin", params: { min: 8 } },
      },
    });
  });

  it("rejects a duplicate email regardless of case", async () => {
    await register();
    const res = await register({ ...USER, email: "TELMAN@example.com" });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("auth.email_taken");
  });

  it("records an audit entry without secrets", async () => {
    await register();
    const log = await prisma.auditLog.findFirstOrThrow({ where: { action: "auth.registered" } });
    expect(JSON.stringify(log)).not.toContain(USER.password);
  });
});

describe("POST /v1/auth/login", () => {
  beforeEach(async () => {
    await register();
  });

  it("logs in with correct credentials (email case-insensitive)", async () => {
    const res = await request(app).post("/v1/auth/login").send({ email: "TELMAN@example.com", password: USER.password });
    expect(res.status).toBe(200);
    expect(res.body.workspace.name).toBe("Telman — iş sahəsi"); // locale "az" at registration
    expect(sessionCookie(res)).toMatch(/^tz_session=/);
  });

  it("gives the same answer for a wrong password and an unknown email", async () => {
    const wrong = await request(app).post("/v1/auth/login").send({ email: USER.email, password: "wrong-password" });
    const unknown = await request(app).post("/v1/auth/login").send({ email: "nobody@example.com", password: "wrong-password" });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body).toEqual(unknown.body);
    expect(wrong.body.code).toBe("auth.invalid_credentials");
    expect(await prisma.auditLog.count({ where: { action: "auth.login.failed" } })).toBe(2);
  });

  it("rate-limits repeated attempts for the same email", async () => {
    const attempt = () => request(app).post("/v1/auth/login").send({ email: "limit@example.com", password: "wrong-password" });
    for (let i = 0; i < 5; i++) expect((await attempt()).status).toBe(401);
    const blocked = await attempt();
    expect(blocked.status).toBe(429);
    expect(blocked.body.code).toBe("rate_limited");
  });
});

describe("session, CSRF and logout", () => {
  it("GET /me requires a session", async () => {
    expect((await request(app).get("/v1/auth/me")).status).toBe(401);
    const reg = await register();
    const me = await request(app).get("/v1/auth/me").set("Cookie", sessionCookie(reg));
    expect(me.status).toBe(200);
    expect(me.body.user.email).toBe("telman@example.com");
    expect(me.body.csrfToken).toBe(reg.body.csrfToken);
  });

  it("logout requires a valid CSRF token and then invalidates the session", async () => {
    const reg = await register();
    const cookie = sessionCookie(reg);

    expect((await request(app).post("/v1/auth/logout").set("Cookie", cookie)).status).toBe(403);
    expect((await request(app).post("/v1/auth/logout").set("Cookie", cookie).set("x-csrf-token", "forged")).status).toBe(403);

    const out = await request(app).post("/v1/auth/logout").set("Cookie", cookie).set("x-csrf-token", reg.body.csrfToken);
    expect(out.status).toBe(204);
    expect((await request(app).get("/v1/auth/me").set("Cookie", cookie)).status).toBe(401);
  });

  it("rejects state-changing requests from foreign origins", async () => {
    const res = await request(app).post("/v1/auth/login").set("Origin", "https://evil.example").send({ email: USER.email, password: USER.password });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("auth.csrf_failed");
  });

  it("allows the configured app origin", async () => {
    await register();
    const res = await request(app).post("/v1/auth/login").set("Origin", "https://telzyra.com").send({ email: USER.email, password: USER.password });
    expect(res.status).toBe(200);
  });

  it("ignores expired and garbage session cookies", async () => {
    const reg = await register();
    await prisma.session.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await request(app).get("/v1/auth/me").set("Cookie", sessionCookie(reg))).status).toBe(401);
    expect((await request(app).get("/v1/auth/me").set("Cookie", "tz_session=garbage")).status).toBe(401);
  });

  it("drops access when the user is removed from the workspace", async () => {
    const reg = await register();
    await prisma.membership.deleteMany({});
    expect((await request(app).get("/v1/auth/me").set("Cookie", sessionCookie(reg))).status).toBe(401);
  });
});

describe("misc", () => {
  it("health reports the database", async () => {
    const res = await request(app).get("/health");
    expect(res.body).toMatchObject({ status: "ok", db: "ok" });
  });
  it("returns JSON errors for bad JSON and unknown routes", async () => {
    const bad = await request(app).post("/v1/auth/login").set("Content-Type", "application/json").send("{oops");
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe("invalid_json");
    expect((await request(app).get("/v1/nope")).body.code).toBe("not_found");
  });
});
