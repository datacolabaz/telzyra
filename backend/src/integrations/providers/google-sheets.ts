import { createHash } from "node:crypto";
import { z } from "zod";
import { ConnectorError } from "../core/errors.js";
import type { ConnectorContext, ConnectorDefinition, HttpClientMapError } from "./shared.js";
import { googleIdentity, googleMapError } from "./shared.js";

/**
 * Google Sheets API v4 — https://developers.google.com/sheets/api/reference/rest
 * Auth: Google OAuth (scope spreadsheets = "sensitive": requires Google app verification for public use).
 * Triggers: Sheets has no native row-change webhooks, so triggers are POLLING with persisted checkpoints.
 * Quotas: per-minute read/write request quotas; 429 RESOURCE_EXHAUSTED is retried with backoff.
 */
const API = "https://sheets.googleapis.com/v4/spreadsheets";
const auth = (ctx: ConnectorContext) => ({ Authorization: `Bearer ${ctx.credentials.accessToken}` });
const cell = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const spreadsheetId = z.string().min(10).max(200).regex(/^[A-Za-z0-9_-]+$/, "Invalid spreadsheet id");

/** Quote a sheet name for A1 notation: 'My Sheet'!A1 */
export const a1Sheet = (sheet: string) => `'${sheet.replace(/'/g, "''")}'`;
const valuesUrl = (id: string, range: string) => `${API}/${id}/values/${encodeURIComponent(range)}`;

function toRecords(rows: unknown[][], header: boolean) {
  if (!header) return rows.map((values, i) => ({ row_number: i + 1, values }));
  const [head = [], ...rest] = rows;
  return rest.map((values, i) => ({
    row_number: i + 2,
    values,
    record: Object.fromEntries((head as unknown[]).map((h, c) => [String(h ?? `column_${c + 1}`), values[c] ?? null])),
  }));
}

async function readSheet(ctx: ConnectorContext, id: string, sheet: string): Promise<unknown[][]> {
  const res = await ctx.http.request<{ values?: unknown[][] }>({ url: valuesUrl(id, `${a1Sheet(sheet)}!A:ZZ`), headers: auth(ctx), query: { majorDimension: "ROWS" } });
  return res.data.values ?? [];
}

const pollConfig = z.object({ spreadsheet_id: spreadsheetId, sheet: z.string().min(1).max(100), header_row: z.boolean().default(true) });
const hashRow = (row: unknown[]) => createHash("sha1").update(JSON.stringify(row)).digest("base64url").slice(0, 16);
const MAX_TRACKED_ROWS = 5000;

export const googleSheets: ConnectorDefinition = {
  id: "google-sheets",
  name: "Google Sheets",
  description: "Read, append and update rows in Google Sheets.",
  category: "productivity",
  auth: { type: "oauth2", provider: "google", scopes: ["openid", "https://www.googleapis.com/auth/userinfo.email", "https://www.googleapis.com/auth/spreadsheets"] },
  requiredEnv: ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"],
  rateLimit: { note: "Per-minute read and write quotas per project and per user; 429 RESOURCE_EXHAUSTED is retried with exponential backoff." },
  mapError: googleMapError("google-sheets") as HttpClientMapError,
  test: (ctx) => googleIdentity(ctx),

  actions: {
    list_sheets: {
      key: "list_sheets",
      name: "List sheets",
      description: "List the tabs of a spreadsheet.",
      input: z.object({ spreadsheet_id: spreadsheetId }),
      async run(ctx, i) {
        const res = await ctx.http.request<{ properties: { title: string }; sheets: Array<{ properties: { sheetId: number; title: string; index: number; gridProperties?: { rowCount: number; columnCount: number } } }> }>({
          url: `${API}/${i.spreadsheet_id}`,
          headers: auth(ctx),
          query: { fields: "properties.title,sheets.properties" },
        });
        return {
          title: res.data.properties.title,
          sheets: res.data.sheets.map((s) => ({ sheet_id: s.properties.sheetId, title: s.properties.title, index: s.properties.index, row_count: s.properties.gridProperties?.rowCount ?? null, column_count: s.properties.gridProperties?.columnCount ?? null })),
        };
      },
    },
    read_rows: {
      key: "read_rows",
      name: "Read rows",
      description: "Read rows from a range (A1 notation, e.g. Sheet1!A1:F100).",
      input: z.object({ spreadsheet_id: spreadsheetId, range: z.string().min(1).max(200), first_row_is_header: z.boolean().default(true) }),
      async run(ctx, i) {
        const res = await ctx.http.request<{ range: string; values?: unknown[][] }>({ url: valuesUrl(i.spreadsheet_id, i.range), headers: auth(ctx), query: { majorDimension: "ROWS" } });
        const rows = toRecords(res.data.values ?? [], i.first_row_is_header);
        return { range: res.data.range, count: rows.length, rows };
      },
    },
    append_row: {
      key: "append_row",
      name: "Append row",
      description: "Add a row at the end of a sheet.",
      input: z.object({ spreadsheet_id: spreadsheetId, sheet: z.string().min(1).max(100), values: z.array(cell).min(1).max(200) }),
      async run(ctx, i) {
        const res = await ctx.http.request<{ updates: { updatedRange: string; updatedRows: number } }>({
          method: "POST",
          url: `${valuesUrl(i.spreadsheet_id, `${a1Sheet(i.sheet)}!A1`)}:append`,
          headers: auth(ctx),
          query: { valueInputOption: "USER_ENTERED", insertDataOption: "INSERT_ROWS" },
          json: { majorDimension: "ROWS", values: [i.values] },
        });
        return { updated_range: res.data.updates.updatedRange, updated_rows: res.data.updates.updatedRows };
      },
    },
    update_range: {
      key: "update_range",
      name: "Update row or range",
      description: "Overwrite the values of a range (A1 notation).",
      input: z.object({ spreadsheet_id: spreadsheetId, range: z.string().min(1).max(200), values: z.array(z.array(cell).max(200)).min(1).max(1000) }),
      async run(ctx, i) {
        const res = await ctx.http.request<{ updatedRange: string; updatedRows: number; updatedCells: number }>({
          method: "PUT",
          url: valuesUrl(i.spreadsheet_id, i.range),
          headers: auth(ctx),
          query: { valueInputOption: "USER_ENTERED" },
          json: { range: i.range, majorDimension: "ROWS", values: i.values },
        });
        return { updated_range: res.data.updatedRange, updated_rows: res.data.updatedRows, updated_cells: res.data.updatedCells };
      },
    },
    clear_range: {
      key: "clear_range",
      name: "Clear range",
      description: "Clear the values of a range, keeping formatting.",
      input: z.object({ spreadsheet_id: spreadsheetId, range: z.string().min(1).max(200) }),
      async run(ctx, i) {
        const res = await ctx.http.request<{ clearedRange: string }>({ method: "POST", url: `${valuesUrl(i.spreadsheet_id, i.range)}:clear`, headers: auth(ctx), json: {}, retryNonIdempotent: true });
        return { cleared_range: res.data.clearedRange };
      },
    },
    create_spreadsheet: {
      key: "create_spreadsheet",
      name: "Create spreadsheet",
      description: "Create a new spreadsheet, optionally with named tabs.",
      input: z.object({ title: z.string().min(1).max(200), sheet_titles: z.array(z.string().min(1).max(100)).max(20).optional() }),
      async run(ctx, i) {
        const res = await ctx.http.request<{ spreadsheetId: string; spreadsheetUrl: string }>({
          method: "POST",
          url: API,
          headers: auth(ctx),
          json: { properties: { title: i.title }, ...(i.sheet_titles?.length ? { sheets: i.sheet_titles.map((title: string) => ({ properties: { title } })) } : {}) },
        });
        return { spreadsheet_id: res.data.spreadsheetId, url: res.data.spreadsheetUrl };
      },
    },
  },

  triggers: {
    new_row: {
      key: "new_row",
      name: "New row (polling)",
      description: "Checks the sheet on a schedule and starts for each row added at the end.",
      mode: "polling",
      config: pollConfig,
      async poll(ctx, config, cursor) {
        const rows = await readSheet(ctx, config.spreadsheet_id, config.sheet);
        const prev = (cursor as { rowCount?: number } | undefined)?.rowCount;
        const next = { rowCount: rows.length };
        // First run (or the sheet shrank): establish a baseline without emitting old rows.
        if (prev === undefined || rows.length < prev) return { events: [], cursor: next };
        const records = toRecords(rows, config.header_row);
        const fresh = records.filter((r) => r.row_number > prev);
        return {
          events: fresh.map((r) => ({ trigger: "new_row", id: `${config.spreadsheet_id}:${config.sheet}:${r.row_number}:${hashRow(r.values as unknown[])}`, data: { spreadsheet_id: config.spreadsheet_id, sheet: config.sheet, ...r } })),
          cursor: next,
        };
      },
      sample: { spreadsheet_id: "1AbC", sheet: "Leads", row_number: 7, values: ["Jane", "jane@example.com"], record: { Name: "Jane", Email: "jane@example.com" } },
    },
    updated_row: {
      key: "updated_row",
      name: "Updated row (polling)",
      description: "Detects rows whose values changed since the previous check (first 5,000 rows).",
      mode: "polling",
      config: pollConfig,
      async poll(ctx, config, cursor) {
        const rows = (await readSheet(ctx, config.spreadsheet_id, config.sheet)).slice(0, MAX_TRACKED_ROWS);
        const prev = (cursor as { hashes?: Record<string, string> } | undefined)?.hashes;
        const hashes = Object.fromEntries(rows.map((r, i) => [String(i + 1), hashRow(r)]));
        if (!prev) return { events: [], cursor: { hashes } };
        const records = toRecords(rows, config.header_row);
        const changed = records.filter((r) => prev[String(r.row_number)] !== undefined && prev[String(r.row_number)] !== hashes[String(r.row_number)]);
        return {
          events: changed.map((r) => ({ trigger: "updated_row", id: `${config.spreadsheet_id}:${config.sheet}:${r.row_number}:${hashes[String(r.row_number)]}`, data: { spreadsheet_id: config.spreadsheet_id, sheet: config.sheet, ...r } })),
          cursor: { hashes },
        };
      },
      sample: { spreadsheet_id: "1AbC", sheet: "Leads", row_number: 3, values: ["Jane", "Won"], record: { Name: "Jane", Status: "Won" } },
    },
  },
};


