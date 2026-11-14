import { createHmac } from "node:crypto";
import { z } from "zod";
import { env } from "../../config/env.js";
import { safeEqual } from "../../security/crypto.js";
import { ConnectorError } from "../core/errors.js";
import type { ConnectorContext, ConnectorDefinition, TriggerEvent } from "../core/types.js";

/**
 * Slack Web API + Events API — https://api.slack.com/methods , https://api.slack.com/apis/events-api
 * Auth: OAuth v2, bot token (least-privilege bot scopes; public channels only).
 * Events: one Request URL for the Slack app; requests are verified with the signing secret
 * (v0 HMAC over "v0:<timestamp>:<body>", 5-minute replay window) and routed by team_id.
 * Rate limits: per-method tiers; 429 responses carry Retry-After.
 */
const API = "https://slack.com/api";
export const SLACK_SCOPES = ["chat:write", "channels:read", "channels:history", "im:write"];
const REPLAY_WINDOW_S = 5 * 60;

async function call<T>(ctx: ConnectorContext, method: string, form: Record<string, string | number | boolean | undefined>, opts: { read?: boolean } = {}): Promise<T> {
  const res = await ctx.http.request<T>({
    method: "POST",
    url: `${API}/${method}`,
    headers: { Authorization: `Bearer ${ctx.credentials.accessToken}` },
    form,
    // Read methods are safe to retry on transient errors; writes only on 429.
    retryNonIdempotent: opts.read,
  });
  return res.data;
}

const AUTH_REVOKED = new Set(["invalid_auth", "not_authed", "token_revoked", "account_inactive", "no_permission"]);
const NOT_FOUND = new Set(["channel_not_found", "user_not_found", "message_not_found", "thread_not_found"]);

export function slackSignature(secret: string, timestamp: string, body: string) {
  return `v0=${createHmac("sha256", secret).update(`v0:${timestamp}:${body}`).digest("hex")}`;
}

interface SlackMessage {
  type: string;
  subtype?: string;
  channel?: string;
  user?: string;
  bot_id?: string;
  text?: string;
  ts?: string;
  thread_ts?: string;
}

export const slack: ConnectorDefinition = {
  id: "slack",
  name: "Slack",
  description: "Post messages and react to messages in your Slack workspace.",
  category: "communication",
  auth: { type: "oauth2", provider: "slack", scopes: SLACK_SCOPES },
  requiredEnv: ["SLACK_CLIENT_ID", "SLACK_CLIENT_SECRET", "SLACK_SIGNING_SECRET"],
  rateLimit: { note: "Tiered per method (e.g. chat.postMessage ~1 message/second per channel); 429 with Retry-After." },

  isErrorBody: (d) => (d as { ok?: boolean })?.ok === false,
  mapError(res) {
    const err = String((res.data as { error?: string })?.error ?? "");
    const details = { provider: "slack", status: res.status, providerCode: err || undefined };
    if (res.status === 429 || err === "ratelimited") return new ConnectorError("RATE_LIMITED", "Slack rate limit", details);
    if (err === "token_expired") return new ConnectorError("AUTH_EXPIRED", err, details);
    if (AUTH_REVOKED.has(err)) return new ConnectorError("AUTH_REVOKED", err, details);
    if (err === "missing_scope" || err === "not_in_channel" || err === "is_archived" || err === "restricted_action") return new ConnectorError("PERMISSION_DENIED", err, details);
    if (NOT_FOUND.has(err)) return new ConnectorError("NOT_FOUND", err, details);
    if (res.status >= 500 || err === "internal_error" || err === "fatal_error") return new ConnectorError("PROVIDER_UNAVAILABLE", err || `HTTP ${res.status}`, details);
    return new ConnectorError("VALIDATION", err || `HTTP ${res.status}`, details);
  },

  async test(ctx) {
    const r = await call<{ team_id: string; team: string }>(ctx, "auth.test", {}, { read: true });
    return { accountId: r.team_id, accountName: r.team };
  },

  actions: {
    send_channel_message: {
      key: "send_channel_message",
      name: "Send channel message",
      description: "Post a message to a channel the bot is a member of.",
      input: z.object({ channel: z.string().min(1).max(50), text: z.string().min(1).max(40000), thread_ts: z.string().max(40).optional() }),
      async run(ctx, i) {
        const r = await call<{ channel: string; ts: string }>(ctx, "chat.postMessage", i);
        return { channel: r.channel, ts: r.ts };
      },
    },
    send_direct_message: {
      key: "send_direct_message",
      name: "Send direct message",
      description: "Send a direct message from the bot to a user.",
      input: z.object({ user: z.string().min(1).max(50), text: z.string().min(1).max(40000) }),
      async run(ctx, i) {
        const open = await call<{ channel: { id: string } }>(ctx, "conversations.open", { users: i.user }, { read: true });
        const r = await call<{ channel: string; ts: string }>(ctx, "chat.postMessage", { channel: open.channel.id, text: i.text });
        return { channel: r.channel, ts: r.ts };
      },
    },
    list_channels: {
      key: "list_channels",
      name: "List channels",
      description: "List public channels visible to the bot.",
      input: z.object({ cursor: z.string().max(200).optional(), limit: z.number().int().min(1).max(1000).default(200), exclude_archived: z.boolean().default(true) }),
      async run(ctx, i) {
        const r = await call<{ channels: Array<{ id: string; name: string; is_member: boolean; num_members?: number }>; response_metadata?: { next_cursor?: string } }>(
          ctx,
          "conversations.list",
          { types: "public_channel", limit: i.limit, cursor: i.cursor, exclude_archived: i.exclude_archived },
          { read: true },
        );
        return { channels: r.channels.map((c) => ({ id: c.id, name: c.name, is_member: c.is_member, members: c.num_members ?? null })), next_cursor: r.response_metadata?.next_cursor || null };
      },
    },
    get_message: {
      key: "get_message",
      name: "Retrieve message",
      description: "Get a message by channel and timestamp (ts).",
      input: z.object({ channel: z.string().min(1).max(50), ts: z.string().min(1).max(40) }),
      async run(ctx, i) {
        const r = await call<{ messages: SlackMessage[] }>(ctx, "conversations.history", { channel: i.channel, latest: i.ts, oldest: i.ts, inclusive: true, limit: 1 }, { read: true });
        const m = r.messages[0];
        if (!m) throw new ConnectorError("NOT_FOUND", "message_not_found", { provider: "slack" });
        return { channel: i.channel, ts: m.ts, text: m.text ?? "", user: m.user ?? null, thread_ts: m.thread_ts ?? null };
      },
    },
  },

  triggers: {
    new_message: {
      key: "new_message",
      name: "New channel message",
      description: "Starts when a person posts in a public channel the bot is a member of.",
      mode: "webhook",
      config: z.object({ channel: z.string().max(50).optional() }),
      matches: (e, c) => !c.channel || (e.data as { channel?: string }).channel === c.channel,
      sample: { channel: "C0123456789", user: "U0123456789", text: "Hello team", ts: "1767225600.000100", thread_ts: null, team_id: "T0123456789" },
    },
    app_mention: {
      key: "app_mention",
      name: "Bot mentioned",
      description: "Starts when someone mentions the bot.",
      mode: "webhook",
      config: z.object({}),
      matches: () => true,
      sample: { channel: "C0123456789", user: "U0123456789", text: "<@U0BOT> help", ts: "1767225600.000200", team_id: "T0123456789" },
    },
    slack_event: {
      key: "slack_event",
      name: "Slack event",
      description: "Starts on any subscribed Slack event type (e.g. reaction_added).",
      mode: "webhook",
      config: z.object({ event_type: z.string().min(1).max(100) }),
      matches: (e, c) => (e.data as { type?: string }).type === c.event_type,
      sample: { type: "reaction_added", event: { reaction: "thumbsup" }, team_id: "T0123456789" },
    },
  },

  webhook: {
    routing: "app",
    verify(req) {
      const secret = env.SLACK_SIGNING_SECRET;
      const ts = req.headers["x-slack-request-timestamp"];
      const sig = req.headers["x-slack-signature"];
      if (!secret || !ts || !sig || !/^\d+$/.test(ts)) return false;
      if (Math.abs(Date.now() / 1000 - Number(ts)) > REPLAY_WINDOW_S) return false; // replay protection
      return safeEqual(slackSignature(secret, ts, req.rawBody.toString("utf8")), sig);
    },
    parse(req) {
      const body = JSON.parse(req.rawBody.toString("utf8")) as { type: string; challenge?: string; event_id?: string; team_id?: string; event?: SlackMessage };
      if (body.type === "url_verification") return { challenge: { challenge: body.challenge } };
      if (body.type !== "event_callback" || !body.event_id) return {};
      return { dedupeKey: body.event_id, eventType: body.event?.type, accountId: body.team_id, payload: body };
    },
    toEvents(payload) {
      const p = payload as { event_id: string; team_id: string; event: SlackMessage & Record<string, unknown> };
      const e = p.event;
      const events: TriggerEvent[] = [{ trigger: "slack_event", id: p.event_id, data: { type: e.type, event: e, team_id: p.team_id } }];
      const fromHuman = !e.subtype && !e.bot_id; // ignore bot messages (prevents loops) and edits/joins
      if (e.type === "message" && fromHuman) events.push({ trigger: "new_message", id: p.event_id, data: { channel: e.channel, user: e.user, text: e.text ?? "", ts: e.ts, thread_ts: e.thread_ts ?? null, team_id: p.team_id } });
      if (e.type === "app_mention") events.push({ trigger: "app_mention", id: p.event_id, data: { channel: e.channel, user: e.user, text: e.text ?? "", ts: e.ts, team_id: p.team_id } });
      return events;
    },
  },
};
