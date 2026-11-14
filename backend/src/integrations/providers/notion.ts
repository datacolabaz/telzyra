import { createHmac } from "node:crypto";
import { z } from "zod";
import { env } from "../../config/env.js";
import { safeEqual } from "../../security/crypto.js";
import { ConnectorError } from "../core/errors.js";
import type { ConnectorContext, ConnectorDefinition, TriggerEvent } from "../core/types.js";

/**
 * Notion API — https://developers.notion.com/reference
 * Version 2025-09-03: databases contain "data sources"; database entries are pages whose parent
 * is a data_source_id. Auth: OAuth public integration; users pick which pages to share.
 * Webhooks: configured once for the integration; X-Notion-Signature = "sha256=" + HMAC(body,
 * verification_token). Polling trigger is offered as a fallback when webhooks are not set up.
 * Rate limit: ~3 requests/second per integration; 429 with Retry-After.
 */
const API = "https://api.notion.com/v1";
export const NOTION_VERSION = "2025-09-03";

const headers = (ctx: ConnectorContext) => ({ Authorization: `Bearer ${ctx.credentials.accessToken}`, "Notion-Version": NOTION_VERSION });
const notionId = z.string().regex(/^[0-9a-fA-F-]{32,36}$/, "Invalid Notion id");

type RichText = Array<{ plain_text?: string }>;
const plain = (rt: RichText | undefined) => (rt ?? []).map((t) => t.plain_text ?? "").join("");

function titleOf(obj: { properties?: Record<string, { type?: string; title?: RichText }>; title?: RichText }): string {
  if (obj.title) return plain(obj.title);
  const t = Object.values(obj.properties ?? {}).find((p) => p.type === "title");
  return plain(t?.title);
}

const paragraphs = (text: string) =>
  text
    .split(/\n{2,}/)
    .filter(Boolean)
    .slice(0, 100)
    .map((p) => ({ object: "block", type: "paragraph", paragraph: { rich_text: [{ type: "text", text: { content: p.slice(0, 2000) } }] } }));

const ERROR_CODES: Record<string, ConnectorError["code"]> = {
  unauthorized: "AUTH_REVOKED",
  restricted_resource: "PERMISSION_DENIED",
  object_not_found: "NOT_FOUND",
  validation_error: "VALIDATION",
  invalid_json: "VALIDATION",
  invalid_request: "VALIDATION",
  invalid_request_url: "VALIDATION",
  rate_limited: "RATE_LIMITED",
  conflict_error: "PROVIDER_UNAVAILABLE",
  internal_server_error: "PROVIDER_UNAVAILABLE",
  service_unavailable: "PROVIDER_UNAVAILABLE",
  gateway_timeout: "TIMEOUT",
};

export const notionSignature = (token: string, body: string) => `sha256=${createHmac("sha256", token).update(body).digest("hex")}`;

interface NotionPage {
  id: string;
  object: string;
  url?: string;
  last_edited_time?: string;
  properties?: Record<string, { type?: string; title?: RichText }>;
  title?: RichText;
  parent?: Record<string, unknown>;
}

export const notion: ConnectorDefinition = {
  id: "notion",
  name: "Notion",
  description: "Search, create and update Notion pages and database entries.",
  category: "productivity",
  auth: { type: "oauth2", provider: "notion", scopes: [] },
  requiredEnv: ["NOTION_CLIENT_ID", "NOTION_CLIENT_SECRET"],
  rateLimit: { note: "Average of 3 requests per second per integration; 429 with Retry-After.", requestsPerSecond: 3 },

  mapError(res) {
    const d = (res.data ?? {}) as { code?: string; message?: string };
    const code: ConnectorError["code"] = (d.code ? ERROR_CODES[d.code] : undefined) ?? (res.status === 429 ? "RATE_LIMITED" : res.status >= 500 ? "PROVIDER_UNAVAILABLE" : res.status === 404 ? "NOT_FOUND" : "VALIDATION");
    return new ConnectorError(code, d.message ?? `HTTP ${res.status}`, { provider: "notion", status: res.status, providerCode: d.code });
  },

  async test(ctx) {
    const r = await ctx.http.request<{ bot?: { workspace_name?: string } }>({ url: `${API}/users/me`, headers: headers(ctx) });
    return { accountId: ctx.connection.externalAccountId ?? undefined, accountName: r.data.bot?.workspace_name ?? "Notion workspace" };
  },

  actions: {
    search: {
      key: "search",
      name: "Search pages",
      description: "Search pages and data sources shared with Telzyra.",
      input: z.object({ query: z.string().max(200).optional(), object: z.enum(["page", "data_source"]).optional(), page_size: z.number().int().min(1).max(100).default(20), start_cursor: z.string().max(200).optional() }),
      async run(ctx, i) {
        const r = await ctx.http.request<{ results: NotionPage[]; next_cursor: string | null }>({
          method: "POST",
          url: `${API}/search`,
          headers: headers(ctx),
          json: { query: i.query, page_size: i.page_size, start_cursor: i.start_cursor, ...(i.object ? { filter: { property: "object", value: i.object } } : {}) },
          retryNonIdempotent: true, // search is read-only
        });
        return { results: r.data.results.map((p) => ({ id: p.id, object: p.object, title: titleOf(p), url: p.url ?? null, last_edited_time: p.last_edited_time ?? null })), next_cursor: r.data.next_cursor };
      },
    },
    create_page: {
      key: "create_page",
      name: "Create page",
      description: "Create a page under a parent page, with optional text content.",
      input: z.object({ parent_page_id: notionId, title: z.string().min(1).max(2000), content: z.string().max(100_000).optional() }),
      async run(ctx, i) {
        const r = await ctx.http.request<NotionPage>({
          method: "POST",
          url: `${API}/pages`,
          headers: headers(ctx),
          json: { parent: { page_id: i.parent_page_id }, properties: { title: { title: [{ type: "text", text: { content: i.title } }] } }, ...(i.content ? { children: paragraphs(i.content) } : {}) },
        });
        return { id: r.data.id, url: r.data.url ?? null };
      },
    },
    create_database_entry: {
      key: "create_database_entry",
      name: "Create database entry",
      description: "Add an entry to a database (data source). Properties use Notion's property value format.",
      input: z.object({ data_source_id: notionId, properties: z.record(z.string(), z.unknown()), content: z.string().max(100_000).optional() }),
      async run(ctx, i) {
        const r = await ctx.http.request<NotionPage>({
          method: "POST",
          url: `${API}/pages`,
          headers: headers(ctx),
          json: { parent: { type: "data_source_id", data_source_id: i.data_source_id }, properties: i.properties, ...(i.content ? { children: paragraphs(i.content) } : {}) },
        });
        return { id: r.data.id, url: r.data.url ?? null };
      },
    },
    update_page: {
      key: "update_page",
      name: "Update page properties",
      description: "Update property values of a page or database entry.",
      input: z.object({ page_id: notionId, properties: z.record(z.string(), z.unknown()), in_trash: z.boolean().optional() }),
      async run(ctx, i) {
        const r = await ctx.http.request<NotionPage>({ method: "PATCH", url: `${API}/pages/${i.page_id}`, headers: headers(ctx), json: { properties: i.properties, ...(i.in_trash !== undefined ? { in_trash: i.in_trash } : {}) }, retryNonIdempotent: true });
        return { id: r.data.id, url: r.data.url ?? null, last_edited_time: r.data.last_edited_time ?? null };
      },
    },
    get_page_content: {
      key: "get_page_content",
      name: "Retrieve page content",
      description: "Get a page's properties and its text blocks.",
      input: z.object({ page_id: notionId, page_size: z.number().int().min(1).max(100).default(100) }),
      async run(ctx, i) {
        const [page, blocks] = await Promise.all([
          ctx.http.request<NotionPage>({ url: `${API}/pages/${i.page_id}`, headers: headers(ctx) }),
          ctx.http.request<{ results: Array<{ id: string; type: string; has_children: boolean; [k: string]: unknown }>; has_more: boolean }>({ url: `${API}/blocks/${i.page_id}/children`, headers: headers(ctx), query: { page_size: i.page_size } }),
        ]);
        const items = blocks.data.results.map((b) => ({ id: b.id, type: b.type, text: plain((b[b.type] as { rich_text?: RichText } | undefined)?.rich_text), has_children: b.has_children }));
        return { id: page.data.id, title: titleOf(page.data), url: page.data.url ?? null, properties: page.data.properties ?? {}, blocks: items, text: items.map((b) => b.text).filter(Boolean).join("\n"), truncated: blocks.data.has_more };
      },
    },
  },

  triggers: {
    page_created: {
      key: "page_created",
      name: "Page created",
      description: "Starts when a page is created in content shared with Telzyra (webhook).",
      mode: "webhook",
      config: z.object({ parent_id: z.string().max(40).optional() }),
      matches: (e, c) => !c.parent_id || (e.data as { parent_id?: string }).parent_id?.replace(/-/g, "") === c.parent_id.replace(/-/g, ""),
      sample: { page_id: "2a0b…", parent_id: "1f3c…", event_type: "page.created", timestamp: "2026-11-14T10:00:00.000Z" },
    },
    page_updated: {
      key: "page_updated",
      name: "Page updated",
      description: "Starts when page properties or content change (webhook).",
      mode: "webhook",
      config: z.object({ parent_id: z.string().max(40).optional() }),
      matches: (e, c) => !c.parent_id || (e.data as { parent_id?: string }).parent_id?.replace(/-/g, "") === c.parent_id.replace(/-/g, ""),
      sample: { page_id: "2a0b…", parent_id: "1f3c…", event_type: "page.properties_updated", timestamp: "2026-11-14T10:00:00.000Z" },
    },
    updated_pages_polling: {
      key: "updated_pages_polling",
      name: "New or updated page (polling)",
      description: "Checks on a schedule for pages edited since the last check.",
      mode: "polling",
      config: z.object({ query: z.string().max(200).optional() }),
      async poll(ctx, config, cursor) {
        const r = await ctx.http.request<{ results: NotionPage[] }>({
          method: "POST",
          url: `${API}/search`,
          headers: headers(ctx),
          json: { query: config.query, filter: { property: "object", value: "page" }, sort: { timestamp: "last_edited_time", direction: "descending" }, page_size: 50 },
          retryNonIdempotent: true,
        });
        const since = (cursor as { since?: string } | undefined)?.since;
        const newest = r.data.results[0]?.last_edited_time ?? since ?? new Date().toISOString();
        if (!since) return { events: [], cursor: { since: newest } };
        const fresh = r.data.results.filter((p) => (p.last_edited_time ?? "") > since);
        return {
          events: fresh.map((p) => ({ trigger: "updated_pages_polling", id: `${p.id}:${p.last_edited_time}`, data: { page_id: p.id, title: titleOf(p), url: p.url ?? null, last_edited_time: p.last_edited_time } })),
          cursor: { since: newest },
        };
      },
      sample: { page_id: "2a0b…", title: "Meeting notes", url: "https://www.notion.so/…", last_edited_time: "2026-11-14T10:00:00.000Z" },
    },
  },

  webhook: {
    routing: "app",
    verify(req) {
      const body = req.rawBody.toString("utf8");
      // The one-time verification request carries the token itself and has no signature yet.
      if (isVerificationRequest(body)) return true;
      const token = env.NOTION_WEBHOOK_VERIFICATION_TOKEN;
      const sig = req.headers["x-notion-signature"];
      return !!token && !!sig && safeEqual(notionSignature(token, body), sig);
    },
    parse(req) {
      const body = JSON.parse(req.rawBody.toString("utf8")) as { id?: string; type?: string; workspace_id?: string; verification_token?: string };
      if (body.verification_token) return { dedupeKey: `verification:${body.verification_token.slice(-8)}`, eventType: "verification", payload: body };
      if (!body.id) return {};
      return { dedupeKey: body.id, eventType: body.type, accountId: body.workspace_id, payload: body };
    },
    toEvents(payload) {
      const p = payload as { id: string; type?: string; timestamp?: string; entity?: { id: string; type: string }; data?: { parent?: { id?: string } } };
      if (!p.type || p.entity?.type !== "page") return [];
      const data = { page_id: p.entity.id, parent_id: p.data?.parent?.id ?? null, event_type: p.type, timestamp: p.timestamp ?? null };
      const events: TriggerEvent[] = [];
      if (p.type === "page.created") events.push({ trigger: "page_created", id: p.id, data });
      if (p.type === "page.properties_updated" || p.type === "page.content_updated") events.push({ trigger: "page_updated", id: p.id, data });
      return events;
    },
  },
};

export function isVerificationRequest(body: string): boolean {
  try {
    const b = JSON.parse(body) as Record<string, unknown>;
    return typeof b.verification_token === "string" && Object.keys(b).length === 1;
  } catch {
    return false;
  }
}
