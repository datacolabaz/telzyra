import { http, HttpResponse } from "msw";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
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

describe("Gmail", () => {
  it("search_messages returns from, to, subject and date (metadata headers requested as repeated params)", async () => {
    const requested = gmailLikeApi();
    const conn = await seedOAuthConnection(h.services, owner, "gmail");
    const res = await owner.post("/v1/workflows/test-step", { connector: "gmail", action: "search_messages", connectionId: conn.id, input: { query: "subject:Telzyra" } });
    expect(res.body.ok).toBe(true);
    expect(res.body.output.messages[0]).toMatchObject({ id: "m1", from: HEADERS.From, to: HEADERS.To, subject: HEADERS.Subject, date: HEADERS.Date });
    expect(requested[0]).toEqual(["From", "To", "Subject", "Date"]);
  });
});
