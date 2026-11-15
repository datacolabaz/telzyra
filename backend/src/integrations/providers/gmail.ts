import { z } from "zod";
import { ConnectorError } from "../core/errors.js";
import type { ConnectorContext, ConnectorDefinition } from "../core/types.js";
import { googleIdentity, googleMapError } from "./shared.js";

/**
 * Gmail API v1 — https://developers.google.com/gmail/api/reference/rest
 * Scopes: gmail.send (sensitive) + gmail.readonly (RESTRICTED: public apps need Google verification
 * and an annual CASA security assessment; until then only test users can connect).
 * New-email trigger uses POLLING (Pub/Sub push would require a Google Cloud Pub/Sub topic).
 */
const API = "https://gmail.googleapis.com/gmail/v1/users/me";
const auth = (ctx: ConnectorContext) => ({ Authorization: `Bearer ${ctx.credentials.accessToken}` });

/** Rejects CR/LF so user input can never inject extra MIME headers. */
const headerSafe = z.string().max(998).refine((v) => !/[\r\n]/.test(v), "Line breaks are not allowed");
const email = z.string().email().max(320);
const emailList = z.union([email, z.array(email).min(1).max(50)]);
const list = (v: string | string[] | undefined) => (Array.isArray(v) ? v.join(", ") : v);

const encodeHeader = (v: string) => (/^[\x20-\x7e]*$/.test(v) ? v : `=?UTF-8?B?${Buffer.from(v, "utf8").toString("base64")}?=`);
const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64").replace(/.{76}/g, "$&\r\n");

export function buildMime(i: { to: string | string[]; cc?: string | string[]; bcc?: string | string[]; reply_to?: string; subject: string; text: string; html?: string }): string {
  const headers = [
    `To: ${list(i.to)}`,
    i.cc ? `Cc: ${list(i.cc)}` : null,
    i.bcc ? `Bcc: ${list(i.bcc)}` : null,
    i.reply_to ? `Reply-To: ${i.reply_to}` : null,
    `Subject: ${encodeHeader(i.subject)}`,
    "MIME-Version: 1.0",
  ].filter(Boolean);
  if (!i.html) {
    return [...headers, 'Content-Type: text/plain; charset="UTF-8"', "Content-Transfer-Encoding: base64", "", b64(i.text)].join("\r\n");
  }
  const boundary = `tz_${Math.random().toString(36).slice(2)}`;
  return [
    ...headers,
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    b64(i.text),
    `--${boundary}`,
    'Content-Type: text/html; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    b64(i.html),
    `--${boundary}--`,
  ].join("\r\n");
}

interface GmailPart {
  mimeType?: string;
  headers?: Array<{ name: string; value: string }>;
  body?: { data?: string; size?: number; attachmentId?: string };
  filename?: string;
  parts?: GmailPart[];
}
interface GmailMessage {
  id: string;
  threadId: string;
  snippet?: string;
  labelIds?: string[];
  internalDate?: string;
  payload?: GmailPart;
}

const header = (m: GmailMessage, name: string) => m.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? null;

function findText(part: GmailPart | undefined, mime: string): string | null {
  if (!part) return null;
  if (part.mimeType === mime && part.body?.data) return Buffer.from(part.body.data, "base64url").toString("utf8");
  for (const p of part.parts ?? []) {
    const t = findText(p, mime);
    if (t) return t;
  }
  return null;
}

function attachments(part: GmailPart | undefined, out: Array<{ filename: string; mime_type: string; size: number }> = []) {
  if (!part) return out;
  if (part.filename && part.body?.attachmentId) out.push({ filename: part.filename, mime_type: part.mimeType ?? "application/octet-stream", size: part.body.size ?? 0 });
  for (const p of part.parts ?? []) attachments(p, out);
  return out;
}

const summary = (m: GmailMessage) => ({
  id: m.id,
  thread_id: m.threadId,
  from: header(m, "From"),
  to: header(m, "To"),
  subject: header(m, "Subject"),
  date: header(m, "Date"),
  snippet: m.snippet ?? "",
  label_ids: m.labelIds ?? [],
});

async function getMessage(ctx: ConnectorContext, id: string, format: "metadata" | "full") {
  const res = await ctx.http.request<GmailMessage>({
    url: `${API}/messages/${encodeURIComponent(id)}`,
    headers: auth(ctx),
    // The summary needs all four headers; Gmail returns only the ones listed (repeated parameter).
    query: format === "metadata" ? { format, metadataHeaders: ["From", "To", "Subject", "Date"] } : { format },
  });
  return res.data;
}

async function search(ctx: ConnectorContext, q: string, max: number, pageToken?: string) {
  const res = await ctx.http.request<{ messages?: Array<{ id: string }>; nextPageToken?: string }>({ url: `${API}/messages`, headers: auth(ctx), query: { q, maxResults: max, pageToken } });
  return res.data;
}

export const gmail: ConnectorDefinition = {
  id: "gmail",
  name: "Gmail",
  description: "Send email and react to new messages in Gmail.",
  category: "communication",
  auth: {
    type: "oauth2",
    provider: "google",
    scopes: ["openid", "https://www.googleapis.com/auth/userinfo.email", "https://www.googleapis.com/auth/gmail.send", "https://www.googleapis.com/auth/gmail.readonly"],
  },
  requiredEnv: ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"],
  rateLimit: { note: "Quota units per user per second (send = 100 units); 429 is retried with backoff." },
  mapError: googleMapError("gmail"),
  test: (ctx) => googleIdentity(ctx),

  actions: {
    send_email: {
      key: "send_email",
      name: "Send email",
      description: "Send an email from the connected Gmail account.",
      input: z.object({ to: emailList, cc: emailList.optional(), bcc: emailList.optional(), reply_to: email.optional(), subject: headerSafe.min(1), text: z.string().min(1).max(500_000), html: z.string().max(1_000_000).optional() }),
      async run(ctx, i) {
        const raw = Buffer.from(buildMime(i), "utf8").toString("base64url");
        const res = await ctx.http.request<{ id: string; threadId: string }>({ method: "POST", url: `${API}/messages/send`, headers: auth(ctx), json: { raw } });
        return { id: res.data.id, thread_id: res.data.threadId };
      },
    },
    search_messages: {
      key: "search_messages",
      name: "Search messages",
      description: "Search using Gmail search syntax (e.g. from:alice subject:invoice).",
      input: z.object({ query: z.string().min(1).max(500), max_results: z.number().int().min(1).max(25).default(10), page_token: z.string().max(200).optional() }),
      async run(ctx, i) {
        const r = await search(ctx, i.query, i.max_results, i.page_token);
        const messages = await Promise.all((r.messages ?? []).map((m) => getMessage(ctx, m.id, "metadata")));
        return { messages: messages.map(summary), next_page_token: r.nextPageToken ?? null };
      },
    },
    read_message: {
      key: "read_message",
      name: "Read email",
      description: "Get the headers, text and attachment list of a message.",
      input: z.object({ message_id: z.string().min(1).max(100) }),
      async run(ctx, i) {
        const m = await getMessage(ctx, i.message_id, "full");
        return { ...summary(m), text: findText(m.payload, "text/plain") ?? "", html: findText(m.payload, "text/html"), attachments: attachments(m.payload) };
      },
    },
  },

  triggers: {
    new_email: {
      key: "new_email",
      name: "New email (polling)",
      description: "Checks on a schedule for new messages matching a Gmail search.",
      mode: "polling",
      config: z.object({ query: z.string().max(500).default("in:inbox") }),
      async poll(ctx, config, cursor) {
        const c = cursor as { since?: number; seen?: string[] } | undefined;
        const now = Math.floor(Date.now() / 1000);
        if (!c?.since) return { events: [], cursor: { since: now, seen: [] } };
        const r = await search(ctx, `${config.query} after:${c.since - 60}`, 25);
        const seen = new Set(c.seen ?? []);
        const fresh = (r.messages ?? []).filter((m) => !seen.has(m.id));
        const messages = await Promise.all(fresh.map((m) => getMessage(ctx, m.id, "metadata")));
        const nextSeen = [...fresh.map((m) => m.id), ...(c.seen ?? [])].slice(0, 500);
        return { events: messages.map((m) => ({ trigger: "new_email", id: m.id, data: summary(m) })), cursor: { since: now, seen: nextSeen } };
      },
      sample: { id: "18c…", thread_id: "18c…", from: "Jane <jane@example.com>", to: "you@example.com", subject: "Invoice", date: "Fri, 14 Nov 2026 10:00:00 +0000", snippet: "Please find…", label_ids: ["INBOX"] },
    },
  },
};


