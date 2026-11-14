import { z } from "zod";
import { ConnectorError, codeForStatus } from "../core/errors.js";
import { assertPublicUrl } from "../core/ssrf.js";
import type { ConnectorDefinition } from "../core/types.js";

/**
 * Core "HTTP Request" step: calls any public REST API. The destination is checked by the SSRF
 * guard (public addresses, http/https, ports 80/443 only); redirects are not followed.
 */
const HEADER_DENY = /^(host|content-length|connection|transfer-encoding|cookie|x-forwarded-.*)$/i;

export const httpRequest: ConnectorDefinition = {
  id: "http",
  name: "HTTP Request",
  description: "Call any public REST API.",
  category: "core",
  auth: { type: "none" },
  rateLimit: { note: "Depends on the destination API; 429 with Retry-After is honoured." },
  mapError: (res) =>
    res.status >= 300 && res.status < 400
      ? new ConnectorError("BLOCKED_DESTINATION", "Redirects are not followed", { provider: "http", status: res.status })
      : new ConnectorError(codeForStatus(res.status), `HTTP ${res.status}`, { provider: "http", status: res.status }),

  async test() {
    return { accountName: "HTTP" };
  },

  actions: {
    request: {
      key: "request",
      name: "HTTP request",
      description: "Send a request and return the status, headers and body.",
      input: z.object({
        method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).default("GET"),
        url: z.string().url().max(2048),
        headers: z.record(z.string().max(100), z.string().max(4000)).default({}),
        query: z.record(z.string().max(100), z.string().max(2000)).optional(),
        body: z.unknown().optional(),
        timeout_ms: z.number().int().min(1000).max(30_000).default(15_000),
      }),
      async run(ctx, i) {
        await assertPublicUrl(i.url);
        const headers = Object.fromEntries(Object.entries(i.headers as Record<string, string>).filter(([k]) => !HEADER_DENY.test(k))) as Record<string, string>;
        const res = await ctx.http.request({
          method: i.method,
          url: i.url,
          headers,
          query: i.query,
          ...(i.body === undefined ? {} : typeof i.body === "string" ? { body: i.body } : { json: i.body }),
          timeoutMs: i.timeout_ms,
          maxRetries: i.method === "GET" ? 2 : 0,
          redirect: "manual", // never follow: a redirect could point to an internal address (3xx fails the step)
        });
        return { status: res.status, content_type: res.headers.get("content-type"), body: res.data };
      },
    },
  },
  triggers: {},
};
