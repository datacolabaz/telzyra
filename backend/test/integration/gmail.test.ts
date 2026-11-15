import { http, HttpResponse } from "msw";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { replaceConnectorForTests } from "../../src/integrations/core/registry.js";
import { buildGmail, gmail } from "../../src/integrations/providers/gmail.js";
import { resetDb } from "../helpers/db.js";
import { harness, mockServer, seedOAuthConnection, signUp, type Agent, type Harness } from "../helpers/integrations.js";

/**
 * Gmail actions against a mock that behaves like the real API in the way that matters here:
 * with format=metadata, Gmail returns ONLY the headers named in the repeated `metadataHeaders`
 * parameter. (Found in the real-provider test on 2026-11-15: subject/to/date came back null.)
 */
const API = "https://gmail.googleapis.com/gmail/v1/users/me";
const HEADERS = { From: "Telman <ugctelman@gmail.com>", To: "ugctelman@gmail.com", Subject: "Telzyra trigger test", Date: "Sun, 15 Nov 2026 16:11:58 +0000", "X-Other": "x" };

beforeAll(() => mockServer.listen({ onUnhandledRequest: "error" }));
afterEach(() => mockServer.resetHandlers());
afterAll(() => mockServer.close());

let h: Harness;
let owner: Agent;
beforeEach(async () => {
  await resetDb();
  h = harness();
  owner = await signUp(h.app, "gmail");
});

const gmailLikeApi = () => {
  const requested: string[][] = [];
  mockServer.use(
    http.get(`${API}/messages`, () => HttpResponse.json({ messages: [{ id: "m1", threadId: "t1" }] })),
    http.get(`${API}/messages/m1`, ({ request }) => {
      const q = new URL(request.url).searchParams;
      const wanted = q.get("format") === "metadata" ? q.getAll("metadataHeaders") : Object.keys(HEADERS);
      requested.push(wanted);
      const headers = Object.entries(HEADERS).filter(([name]) => wanted.includes(name)).map(([name, value]) => ({ name, value }));
      return HttpResponse.json({ id: "m1", threadId: "t1", snippet: "hello", labelIds: ["INBOX"], payload: { mimeType: "text/plain", headers, body: { data: Buffer.from("hello").toString("base64url") } } });
    }),
  );
  return requested;
};

describe("Gmail (default: send only, no restricted scope)", () => {
  it("requests only gmail.send — no gmail.readonly, no read actions, no trigger", async () => {
    expect(gmail.auth.type === "oauth2" && gmail.auth.scopes).toEqual(["openid", "https://www.googleapis.com/auth/userinfo.email", "https://www.googleapis.com/auth/gmail.send"]);
    expect(Object.keys(gmail.actions)).toEqual(["send_email"]);
    expect(Object.keys(gmail.triggers ?? {})).toEqual([]);
    const start = await owner.post("/v1/oauth/gmail/start", {});
    expect(new URL(start.body.url).searchParams.get("scope")).not.toContain("gmail.readonly");
  });
});

describe("Gmail with GMAIL_READ_ENABLED", () => {
  beforeEach(() => replaceConnectorForTests(buildGmail(true)));
  afterAll(() => replaceConnectorForTests(gmail));

  it("adds the read scope, actions and trigger", () => {
    const g = buildGmail(true);
    expect(g.auth.type === "oauth2" && g.auth.scopes).toContain("https://www.googleapis.com/auth/gmail.readonly");
    expect(Object.keys(g.actions)).toEqual(["send_email", "search_messages", "read_message"]);
    expect(Object.keys(g.triggers ?? {})).toEqual(["new_email"]);
  });

  it("search_messages returns from, to, subject and date (metadata headers requested as repeated params)", async () => {
    const requested = gmailLikeApi();
    const conn = await seedOAuthConnection(h.services, owner, "gmail");
    const res = await owner.post("/v1/workflows/test-step", { connector: "gmail", action: "search_messages", connectionId: conn.id, input: { query: "subject:Telzyra" } });
    expect(res.body.ok).toBe(true);
    expect(res.body.output.messages[0]).toMatchObject({ id: "m1", from: HEADERS.From, to: HEADERS.To, subject: HEADERS.Subject, date: HEADERS.Date });
    expect(requested[0]).toEqual(["From", "To", "Subject", "Date"]);
  });
});
