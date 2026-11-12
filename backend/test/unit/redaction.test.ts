import { Writable } from "node:stream";
import { pino } from "pino";
import { describe, expect, it } from "vitest";
import { REDACT_PATHS } from "../../src/lib/logger.js";
import { sanitizeMetadata } from "../../src/audit/audit.service.js";

describe("log redaction", () => {
  it("removes tokens, cookies and signatures from log output", () => {
    let out = "";
    const sink = new Writable({ write(chunk, _enc, cb) { out += chunk.toString(); cb(); } });
    const log = pino({ redact: { paths: REDACT_PATHS, censor: "[REDACTED]" } }, sink);

    log.info({
      req: { headers: { authorization: "Bearer at-123", cookie: "tz_session=abc", "x-slack-signature": "v0=sig" } },
      res: { headers: { "set-cookie": "tz_session=abc" } },
      body: { password: "hunter22", access_token: "at-123", refresh_token: "rt-456", code: "oauth-code" },
    });

    for (const secret of ["at-123", "tz_session=abc", "v0=sig", "hunter22", "rt-456", "oauth-code"]) {
      expect(out).not.toContain(secret);
    }
    expect(out).toContain("[REDACTED]");
  });
});

describe("audit metadata sanitizer", () => {
  it("redacts secret-like keys at any depth and keeps the rest", () => {
    const clean = sanitizeMetadata({
      provider: "slack",
      scopes: ["chat:write"],
      nested: { accessToken: "x", apiKey: "y", note: "ok" },
      list: [{ client_secret: "z" }],
    });
    expect(clean).toEqual({
      provider: "slack",
      scopes: ["chat:write"],
      nested: { accessToken: "[REDACTED]", apiKey: "[REDACTED]", note: "ok" },
      list: [{ client_secret: "[REDACTED]" }],
    });
  });
});
