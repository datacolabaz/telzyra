import { http, HttpResponse } from "msw";

/**
 * Stateful fakes of the Telegram Bot API and Google (OAuth + Sheets) used by the browser E2E run.
 * They follow the real request/response shapes the connectors use. Never used in production.
 */
export interface FakeState {
  telegram: {
    validTokenPattern: RegExp;
    webhookUrl: string | null;
    nextUpdateId: number;
    pending: Array<Record<string, unknown> & { update_id: number }>;
    sent: Array<{ method: string; body: Record<string, unknown> }>;
  };
  google: {
    codes: Set<string>;
    refreshCount: number;
    sheets: Record<string, Record<string, unknown[][]>>; // spreadsheetId -> sheet -> rows
  };
}

export function createFakeState(): FakeState {
  return {
    telegram: { validTokenPattern: /^\d{5,}:[A-Za-z0-9_-]{20,}$/, webhookUrl: null, nextUpdateId: 1000, pending: [], sent: [] },
    google: { codes: new Set(), refreshCount: 0, sheets: { "1E2eSheetLeads000000": { Leads: [["Username", "Message", "Chat"]] } } },
  };
}

const ok = (result: unknown) => HttpResponse.json({ ok: true, result });
const tgError = (code: number, description: string) => HttpResponse.json({ ok: false, error_code: code, description }, { status: code });

export function fakeProviderHandlers(state: FakeState) {
  const tg = state.telegram;
  const tgRoute = (method: string) => `https://api.telegram.org/:bot/${method}`;
  const tokenOk = (bot: string) => bot.startsWith("bot") && tg.validTokenPattern.test(bot.slice(3));
  const body = async (r: Request) => (await r.json().catch(() => ({}))) as Record<string, unknown>;

  const telegram = [
    http.post(tgRoute("getMe"), ({ params }) => (tokenOk(String(params.bot)) ? ok({ id: 7000001, is_bot: true, first_name: "Telzyra E2E", username: "telzyra_e2e_bot" }) : tgError(401, "Unauthorized"))),
    http.post(tgRoute("setWebhook"), async ({ params, request }) => {
      if (!tokenOk(String(params.bot))) return tgError(401, "Unauthorized");
      tg.webhookUrl = String((await request.json() as { url: string }).url);
      return ok(true);
    }),
    http.post(tgRoute("deleteWebhook"), ({ params }) => {
      if (!tokenOk(String(params.bot))) return tgError(401, "Unauthorized");
      tg.webhookUrl = null;
      return ok(true);
    }),
    http.post(tgRoute("getUpdates"), async ({ params, request }) => {
      if (!tokenOk(String(params.bot))) return tgError(401, "Unauthorized");
      if (tg.webhookUrl) return tgError(409, "Conflict: can't use getUpdates method while webhook is active; use deleteWebhook to delete the webhook first");
      const { offset } = (await request.json()) as { offset?: number };
      if (offset !== undefined) tg.pending = tg.pending.filter((u) => u.update_id >= offset); // confirmed updates are dropped, like Telegram
      return ok(tg.pending.slice(0, 100));
    }),
    ...["sendMessage", "sendPhoto", "sendDocument", "editMessageText"].map((m) =>
      http.post(tgRoute(m), async ({ params, request }) => {
        if (!tokenOk(String(params.bot))) return tgError(401, "Unauthorized");
        const b = await body(request);
        if (!b.chat_id) return tgError(400, "Bad Request: chat_id is empty");
        tg.sent.push({ method: m, body: b });
        return ok({ message_id: 9000 + tg.sent.length, date: Math.floor(Date.now() / 1000), chat: { id: Number(b.chat_id), type: "private" }, text: b.text });
      }),
    ),
    http.post(tgRoute("getChat"), async ({ params, request }) => {
      if (!tokenOk(String(params.bot))) return tgError(401, "Unauthorized");
      const b = await body(request);
      return ok({ id: Number(b.chat_id), type: "private", username: "e2e_user" });
    }),
  ];

  const g = state.google;
  const bearerOk = (r: Request) => /^Bearer ya29\.e2e-/.test(r.headers.get("authorization") ?? "");
  const unauthorized = () => HttpResponse.json({ error: { code: 401, message: "Request had invalid authentication credentials.", status: "UNAUTHENTICATED" } }, { status: 401 });
  const google = [
    http.post("https://oauth2.googleapis.com/token", async ({ request }) => {
      const f = new URLSearchParams(await request.text());
      if (f.get("client_id") !== process.env.GOOGLE_CLIENT_ID || f.get("client_secret") !== process.env.GOOGLE_CLIENT_SECRET) return HttpResponse.json({ error: "invalid_client" }, { status: 401 });
      if (f.get("grant_type") === "authorization_code") {
        const code = f.get("code") ?? "";
        if (!g.codes.has(code) || !f.get("code_verifier")) return HttpResponse.json({ error: "invalid_grant" }, { status: 400 });
        g.codes.delete(code);
        return HttpResponse.json({ access_token: "ya29.e2e-access-1", refresh_token: "1//e2e-refresh", expires_in: 3599, token_type: "Bearer", scope: "openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/spreadsheets" });
      }
      if (f.get("grant_type") === "refresh_token" && f.get("refresh_token") === "1//e2e-refresh") {
        g.refreshCount++;
        return HttpResponse.json({ access_token: `ya29.e2e-access-${g.refreshCount + 1}`, expires_in: 3599, scope: "https://www.googleapis.com/auth/spreadsheets" });
      }
      return HttpResponse.json({ error: "invalid_grant" }, { status: 400 });
    }),
    http.post("https://oauth2.googleapis.com/revoke", () => new HttpResponse(null, { status: 200 })),
    http.get("https://openidconnect.googleapis.com/v1/userinfo", ({ request }) => (bearerOk(request) ? HttpResponse.json({ sub: "e2e-google-sub", email: "sheets.e2e@example.com" }) : unauthorized())),
    http.get("https://sheets.googleapis.com/v4/spreadsheets/:id", ({ params, request }) => {
      if (!bearerOk(request)) return unauthorized();
      const doc = g.sheets[String(params.id)];
      if (!doc) return HttpResponse.json({ error: { code: 404, message: "Requested entity was not found.", status: "NOT_FOUND" } }, { status: 404 });
      return HttpResponse.json({ spreadsheetId: params.id, properties: { title: "E2E Leads" }, sheets: Object.keys(doc).map((title, i) => ({ properties: { sheetId: i, title, index: i, gridProperties: { rowCount: 1000, columnCount: 26 } } })) });
    }),
    http.get("https://sheets.googleapis.com/v4/spreadsheets/:id/values/:range", ({ params, request }) => {
      if (!bearerOk(request)) return unauthorized();
      const sheet = String(params.range).split("!")[0]!.replace(/^'|'$/g, "").replace(/''/g, "'");
      const rows = g.sheets[String(params.id)]?.[sheet];
      if (!rows) return HttpResponse.json({ error: { code: 400, message: `Unable to parse range: ${params.range}`, status: "INVALID_ARGUMENT" } }, { status: 400 });
      return HttpResponse.json({ range: params.range, majorDimension: "ROWS", values: rows });
    }),
    http.post("https://sheets.googleapis.com/v4/spreadsheets/:id/values/:range", async ({ params, request }) => {
      if (!bearerOk(request)) return unauthorized();
      const [rangePart] = String(params.range).split(":append");
      const sheet = rangePart!.split("!")[0]!.replace(/^'|'$/g, "").replace(/''/g, "'");
      const rows = g.sheets[String(params.id)]?.[sheet];
      if (!rows) return HttpResponse.json({ error: { code: 400, message: "Unable to parse range", status: "INVALID_ARGUMENT" } }, { status: 400 });
      const { values } = (await request.json()) as { values: unknown[][] };
      rows.push(...values);
      const n = rows.length;
      return HttpResponse.json({ spreadsheetId: params.id, updates: { updatedRange: `${sheet}!A${n}:${String.fromCharCode(64 + values[0]!.length)}${n}`, updatedRows: values.length, updatedCells: values.flat().length } });
    }),
  ];

  return [...telegram, ...google];
}

/** Simulates a user writing to the bot (what Telegram would deliver via getUpdates). */
export function pushTelegramMessage(state: FakeState, msg: { chatId: number; text: string; username: string }) {
  const id = state.telegram.nextUpdateId++;
  state.telegram.pending.push({
    update_id: id,
    message: { message_id: id, date: Math.floor(Date.now() / 1000), text: msg.text, chat: { id: msg.chatId, type: "private", username: msg.username }, from: { id: msg.chatId, is_bot: false, username: msg.username, first_name: msg.username } },
  });
  return id;
}
