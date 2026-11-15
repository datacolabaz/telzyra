import { z } from "zod";
import { ConnectorError } from "../core/errors.js";
import type { ConnectorContext, ConnectorDefinition, TriggerEvent } from "../core/types.js";
import { safeEqual } from "../../security/crypto.js";
import { env, webhookBaseUrl } from "../../config/env.js";

/**
 * Telegram Bot API — https://core.telegram.org/bots/api
 * Auth: bot token from @BotFather. Webhooks: setWebhook with secret_token; Telegram sends it back
 * in X-Telegram-Bot-Api-Secret-Token. While a webhook is set, getUpdates is unavailable (by design).
 */
const API = "https://api.telegram.org";

interface TgResponse<T> {
  ok: boolean;
  result: T;
  error_code?: number;
  description?: string;
  parameters?: { retry_after?: number; migrate_to_chat_id?: number };
}

async function call<T>(ctx: ConnectorContext, method: string, params: Record<string, unknown> = {}): Promise<T> {
  if (!ctx.credentials.botToken) throw new ConnectorError("AUTH_REVOKED", "Bot token missing", { provider: "telegram" });
  const res = await ctx.http.request<TgResponse<T>>({ method: "POST", url: `${API}/bot${ctx.credentials.botToken}/${method}`, json: params });
  return res.data.result;
}

const chatId = z.union([z.string().min(1).max(100), z.number().int()]);
const parseMode = z.enum(["HTML", "MarkdownV2"]).optional();

interface TgMessage {
  message_id: number;
  date: number;
  text?: string;
  caption?: string;
  chat: { id: number; type: string; title?: string; username?: string; first_name?: string };
  from?: { id: number; is_bot: boolean; username?: string; first_name?: string; last_name?: string; language_code?: string };
}

const messageResult = (m: TgMessage) => ({ message_id: m.message_id, chat_id: m.chat.id, date: m.date });

/** Webhooks need a public HTTPS URL; on localhost Telzyra polls getUpdates instead. */
export function telegramTriggerMode(e: { TELEGRAM_TRIGGER_MODE: string; PUBLIC_API_URL: string; PUBLIC_WEBHOOK_URL?: string } = env): "webhook" | "polling" {
  if (e.TELEGRAM_TRIGGER_MODE === "webhook" || e.TELEGRAM_TRIGGER_MODE === "polling") return e.TELEGRAM_TRIGGER_MODE;
  const u = new URL(webhookBaseUrl(e));
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname) || u.hostname.endsWith(".local");
  return u.protocol === "https:" && !local ? "webhook" : "polling";
}
const MODE = telegramTriggerMode();

const UPDATE_TYPES = ["message", "edited_message", "channel_post", "edited_channel_post", "callback_query", "my_chat_member"] as const;

function messageData(updateId: number, m: TgMessage) {
  return {
    update_id: updateId,
    message_id: m.message_id,
    text: m.text ?? m.caption ?? "",
    date: m.date,
    chat: { id: m.chat.id, type: m.chat.type, title: m.chat.title ?? null, username: m.chat.username ?? null },
    from: m.from
      ? { id: m.from.id, is_bot: m.from.is_bot, username: m.from.username ?? null, first_name: m.from.first_name ?? null, last_name: m.from.last_name ?? null, language_code: m.from.language_code ?? null }
      : null,
  };
}

interface TgUpdate {
  update_id: number;
  [k: string]: unknown;
}

/**
 * Polling delivery (getUpdates). The offset confirms updates at Telegram, so only one workflow per
 * bot may consume them (enforced on activation). The first poll ignores updates older than 2 minutes.
 */
async function pollUpdates(ctx: ConnectorContext, cursor: unknown): Promise<{ updates: TgUpdate[]; cursor: { offset: number } }> {
  const c = cursor as { offset?: number } | undefined;
  const params = { offset: c?.offset, timeout: 0, limit: 100, allowed_updates: [...UPDATE_TYPES] };
  let updates: TgUpdate[];
  try {
    updates = await call<TgUpdate[]>(ctx, "getUpdates", params);
  } catch (err) {
    // 409: a webhook is still registered for this bot; remove it and retry once.
    if (err instanceof ConnectorError && err.details.status === 409) {
      await call(ctx, "deleteWebhook", { drop_pending_updates: false });
      updates = await call<TgUpdate[]>(ctx, "getUpdates", params);
    } else throw err;
  }
  const last = updates.at(-1)?.update_id;
  const next = { offset: last !== undefined ? last + 1 : (c?.offset ?? 0) };
  if (c?.offset === undefined) {
    const since = Math.floor(Date.now() / 1000) - 120;
    updates = updates.filter((u) => {
      const m = (u.message ?? u.edited_message ?? u.channel_post) as { date?: number } | undefined;
      return m?.date !== undefined && m.date >= since;
    });
  }
  return { updates, cursor: next };
}

function updateEvents(u: TgUpdate): TriggerEvent[] {
  const type = Object.keys(u).find((k) => k !== "update_id") ?? "unknown";
  return telegram.webhook!.toEvents(u, type);
}

export const telegram: ConnectorDefinition = {
  id: "telegram",
  name: "Telegram",
  description: "Send messages and react to messages received by your Telegram bot.",
  category: "communication",
  auth: { type: "bot_token", label: "Bot token", hint: "Create a bot with @BotFather and paste its token." },
  rateLimit: { note: "About 1 message/second per chat and 30 messages/second per bot; 429 responses include retry_after.", requestsPerSecond: 30 },

  isErrorBody: (d) => (d as TgResponse<unknown>)?.ok === false,
  mapError(res) {
    const d = (res.data ?? {}) as TgResponse<unknown>;
    const status = d.error_code ?? res.status;
    const desc = d.description ?? `HTTP ${status}`;
    const details = { provider: "telegram", status, providerCode: String(status) };
    if (status === 401) return new ConnectorError("AUTH_REVOKED", "Bot token is invalid or was revoked", details);
    if (status === 403) return new ConnectorError("PERMISSION_DENIED", desc, details); // e.g. bot blocked by the user
    if (status === 429) return new ConnectorError("RATE_LIMITED", desc, { ...details, retryAfterMs: (d.parameters?.retry_after ?? 1) * 1000 });
    if (status === 400 && /not found/i.test(desc)) return new ConnectorError("NOT_FOUND", desc, details);
    if (status === 400) return new ConnectorError("VALIDATION", desc, details);
    if (status >= 500) return new ConnectorError("PROVIDER_UNAVAILABLE", desc, details);
    return new ConnectorError("UNKNOWN", desc, details);
  },

  async test(ctx) {
    const me = await call<{ id: number; username?: string; first_name: string }>(ctx, "getMe");
    return { accountId: String(me.id), accountName: me.username ? `@${me.username}` : me.first_name };
  },

  actions: {
    send_message: {
      key: "send_message",
      name: "Send message",
      description: "Send a text message to a chat, group or channel.",
      input: z.object({ chat_id: chatId, text: z.string().min(1).max(4096), parse_mode: parseMode, disable_notification: z.boolean().optional(), reply_to_message_id: z.number().int().optional() }),
      async run(ctx, i) {
        const { reply_to_message_id, ...rest } = i;
        const m = await call<TgMessage>(ctx, "sendMessage", { ...rest, ...(reply_to_message_id ? { reply_parameters: { message_id: reply_to_message_id } } : {}) });
        return messageResult(m);
      },
    },
    send_photo: {
      key: "send_photo",
      name: "Send photo",
      description: "Send a photo by public URL or Telegram file_id.",
      input: z.object({ chat_id: chatId, photo: z.string().min(1).max(2048), caption: z.string().max(1024).optional(), parse_mode: parseMode }),
      async run(ctx, i) {
        return messageResult(await call<TgMessage>(ctx, "sendPhoto", i));
      },
    },
    send_document: {
      key: "send_document",
      name: "Send document",
      description: "Send a file by public URL or Telegram file_id.",
      input: z.object({ chat_id: chatId, document: z.string().min(1).max(2048), caption: z.string().max(1024).optional(), parse_mode: parseMode }),
      async run(ctx, i) {
        return messageResult(await call<TgMessage>(ctx, "sendDocument", i));
      },
    },
    edit_message: {
      key: "edit_message",
      name: "Edit message",
      description: "Edit the text of a message previously sent by the bot.",
      input: z.object({ chat_id: chatId, message_id: z.number().int(), text: z.string().min(1).max(4096), parse_mode: parseMode }),
      async run(ctx, i) {
        const r = await call<TgMessage | true>(ctx, "editMessageText", i);
        return r === true ? { message_id: i.message_id, chat_id: i.chat_id } : messageResult(r);
      },
    },
    get_chat: {
      key: "get_chat",
      name: "Get chat information",
      description: "Get up-to-date information about a chat.",
      input: z.object({ chat_id: chatId }),
      async run(ctx, i) {
        const c = await call<Record<string, unknown>>(ctx, "getChat", i);
        return { id: c.id, type: c.type, title: c.title ?? null, username: c.username ?? null, description: c.description ?? null };
      },
    },
  },

  triggers: {
    new_message: {
      key: "new_message",
      name: "New incoming message",
      description: "Starts when someone sends a message to your bot.",
      mode: MODE,
      pollIntervalMinutes: 1,
      exclusivePerConnection: true,
      async poll(ctx, _config, cursor) {
        const r = await pollUpdates(ctx, cursor);
        return { events: r.updates.flatMap(updateEvents).filter((e) => e.trigger === "new_message"), cursor: r.cursor };
      },
      config: z.object({ chat_id: chatId.optional(), text_contains: z.string().max(200).optional() }),
      matches(event, config) {
        const d = event.data as ReturnType<typeof messageData>;
        if (config.chat_id !== undefined && String(d.chat.id) !== String(config.chat_id)) return false;
        if (config.text_contains && !d.text.toLowerCase().includes(config.text_contains.toLowerCase())) return false;
        return true;
      },
      sample: { update_id: 1, message_id: 42, text: "Hello!", date: 1767225600, chat: { id: 123456789, type: "private", title: null, username: "jane" }, from: { id: 123456789, is_bot: false, username: "jane", first_name: "Jane", last_name: null, language_code: "en" } },
    },
    bot_update: {
      key: "bot_update",
      name: "Bot update",
      description: "Starts on selected update types (edited messages, channel posts, button callbacks, membership changes).",
      mode: MODE,
      pollIntervalMinutes: 1,
      exclusivePerConnection: true,
      async poll(ctx, _config, cursor) {
        const r = await pollUpdates(ctx, cursor);
        return { events: r.updates.flatMap(updateEvents).filter((e) => e.trigger === "bot_update"), cursor: r.cursor };
      },
      config: z.object({ types: z.array(z.enum(UPDATE_TYPES)).min(1).default(["message"]) }),
      matches: (event, config) => config.types.includes((event.data as { type: (typeof UPDATE_TYPES)[number] }).type),
      sample: { type: "callback_query", update: { update_id: 2, callback_query: { id: "1", data: "yes" } } },
    },
  },

  webhook: {
    routing: "per-connection",
    verify(req, secret) {
      const header = req.headers["x-telegram-bot-api-secret-token"];
      return !!secret && !!header && safeEqual(header, secret);
    },
    parse(req) {
      const update = JSON.parse(req.rawBody.toString("utf8")) as { update_id: number; [k: string]: unknown };
      const type = Object.keys(update).find((k) => k !== "update_id") ?? "unknown";
      // update_id is unique per bot; prefix with the endpoint so two bots never collide.
      return { dedupeKey: `${req.params.endpointToken}:${update.update_id}`, eventType: type, payload: update };
    },
    toEvents(payload, eventType) {
      const u = payload as { update_id: number } & Record<string, unknown>;
      const events: TriggerEvent[] = [{ trigger: "bot_update", id: String(u.update_id), data: { type: eventType, update: u } }];
      if (eventType === "message" && u.message) events.push({ trigger: "new_message", id: String(u.update_id), data: messageData(u.update_id, u.message as TgMessage) });
      return events;
    },
    async subscribe(ctx, { url, secret }) {
      await call(ctx, "setWebhook", { url, secret_token: secret, allowed_updates: [...UPDATE_TYPES], drop_pending_updates: false });
      return {};
    },
    async unsubscribe(ctx) {
      await call(ctx, "deleteWebhook", { drop_pending_updates: false });
    },
  },
};
