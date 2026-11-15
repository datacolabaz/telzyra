import { createHmac } from "node:crypto";
import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { parseSignedRequest } from "../../src/integrations/meta-data-deletion.js";
import { prisma, resetDb } from "../helpers/db.js";
import { harness, seedOAuthConnection, signUp, type Agent, type Harness } from "../helpers/integrations.js";

/** Meta Data Deletion Request Callback, with signed_request built exactly as Meta signs it. */
const SECRET = "test-meta-secret";
const b64url = (b: Buffer | string) => Buffer.from(b).toString("base64url");
function signedRequest(payload: Record<string, unknown>, secret = SECRET) {
  const body = b64url(JSON.stringify(payload));
  return `${b64url(createHmac("sha256", secret).update(body).digest())}.${body}`;
}

let h: Harness;
let owner: Agent;
beforeEach(async () => {
  await resetDb();
  h = harness();
  owner = await signUp(h.app, "meta-del");
});

describe("parseSignedRequest", () => {
  it("accepts a valid signature and rejects tampering, wrong secret and wrong algorithm", () => {
    const ok = signedRequest({ algorithm: "HMAC-SHA256", user_id: "123", issued_at: 1 });
    expect(parseSignedRequest(ok, SECRET)).toMatchObject({ user_id: "123" });
    expect(parseSignedRequest(ok, "other-secret")).toBeNull();
    const [sig, body] = ok.split(".");
    expect(parseSignedRequest(`${sig}.${b64url(JSON.stringify({ algorithm: "HMAC-SHA256", user_id: "999" }))}`, SECRET)).toBeNull();
    expect(parseSignedRequest(signedRequest({ algorithm: "none", user_id: "1" }), SECRET)).toBeNull();
    expect(parseSignedRequest(`${sig}.${body}.x`, SECRET)).toBeNull();
  });
});

describe("POST /webhooks/meta/data-deletion", () => {
  it("deletes Meta tokens/ids for that user, pauses workflows, returns url + confirmation code", async () => {
    const ig = await seedOAuthConnection(h.services, owner, "instagram", { accountId: "555" });
    const fb = await seedOAuthConnection(h.services, owner, "facebook-pages", { accountId: "555" });
    const otherUser = await seedOAuthConnection(h.services, owner, "instagram", { accountId: "777" });
    const slack = await seedOAuthConnection(h.services, owner, "slack", { accountId: "555" }); // not Meta: untouched
    const wf = await owner.post("/v1/workflows", { name: "IG", definition: { trigger: { connector: "manual", trigger: "manual", config: {} }, steps: [{ id: "s", connector: "instagram", action: "list_accounts", connectionId: ig.id, input: {} }] } });
    await prisma.workflow.update({ where: { id: wf.body.id }, data: { status: "ACTIVE" } });

    const res = await request(h.app).post("/webhooks/meta/data-deletion").type("form").send({ signed_request: signedRequest({ algorithm: "HMAC-SHA256", user_id: "555", issued_at: 1 }) });
    expect(res.status).toBe(200);
    expect(res.body.confirmation_code).toMatch(/^[A-Z0-9]{6,10}$/);
    expect(res.body.url).toBe(`http://localhost:3000/data-deletion?code=${res.body.confirmation_code}`);

    for (const id of [ig.id, fb.id]) {
      const c = await prisma.connection.findUniqueOrThrow({ where: { id }, include: { credential: true } });
      expect(c).toMatchObject({ status: "REVOKED", externalAccountId: null, credential: null });
    }
    expect((await prisma.connection.findUniqueOrThrow({ where: { id: otherUser.id }, include: { credential: true } })).credential).not.toBeNull();
    expect((await prisma.connection.findUniqueOrThrow({ where: { id: slack.id } })).status).toBe("ACTIVE");
    expect((await prisma.workflow.findUniqueOrThrow({ where: { id: wf.body.id } })).status).toBe("PAUSED");

    const row = await prisma.dataDeletionRequest.findUniqueOrThrow({ where: { confirmationCode: res.body.confirmation_code } });
    expect(row).toMatchObject({ status: "COMPLETED", connectionsAffected: 2 });
    expect(row.subjectHash).not.toContain("555");

    const status = await request(h.app).get(`/v1/data-deletion/${res.body.confirmation_code}`);
    expect(status.status).toBe(200);
    expect(status.body).toMatchObject({ confirmation_code: res.body.confirmation_code, status: "COMPLETED" });
  });

  it("rejects a forged or missing signed_request without deleting anything", async () => {
    const ig = await seedOAuthConnection(h.services, owner, "instagram", { accountId: "555" });
    const forged = await request(h.app).post("/webhooks/meta/data-deletion").type("form").send({ signed_request: signedRequest({ algorithm: "HMAC-SHA256", user_id: "555" }, "attacker") });
    expect(forged.status).toBe(400);
    expect((await request(h.app).post("/webhooks/meta/data-deletion").type("form").send({})).status).toBe(400);
    expect((await prisma.connection.findUniqueOrThrow({ where: { id: ig.id } })).status).toBe("ACTIVE");
    expect(await prisma.dataDeletionRequest.count()).toBe(0);
  });

  it("unknown confirmation codes are 404", async () => {
    expect((await request(h.app).get("/v1/data-deletion/NOPE1234")).status).toBe(404);
    expect((await request(h.app).get("/v1/data-deletion/..%2F")).status).toBe(404);
  });
});
