import { createHmac } from "node:crypto";
import { env } from "../../config/env.js";
import { ConnectorError } from "../core/errors.js";
import type { HttpResponse } from "../core/http.js";
import type { ConnectorContext } from "../core/types.js";

/**
 * Shared Meta Graph API helpers for the Facebook Pages and Instagram connectors.
 * https://developers.facebook.com/docs/graph-api
 *
 * - Every call carries appsecret_proof = HMAC-SHA256(app secret, access token), so a leaked token
 *   cannot be used without the app secret.
 * - The connection stores a long-lived USER token (~60 days, no refresh token). Page tokens are
 *   derived per call and never stored or returned.
 */
export const graphBase = () => `https://graph.facebook.com/${env.META_GRAPH_VERSION}`;

export const appSecretProof = (token: string) => createHmac("sha256", env.META_APP_SECRET ?? "").update(token).digest("hex");

interface GraphError {
  message?: string;
  type?: string;
  code?: number;
  error_subcode?: number;
  is_transient?: boolean;
  error_user_msg?: string;
}

const RATE_LIMIT_CODES = new Set([4, 17, 32, 613, 80001, 80002, 80004, 80005, 80006, 80008, 80014]);

export function metaMapError(provider: string) {
  return (res: HttpResponse): ConnectorError => {
    const e: GraphError = (res.data as { error?: GraphError })?.error ?? {};
    const code = e.code ?? 0;
    const msg = e.error_user_msg ?? e.message ?? `HTTP ${res.status}`;
    const details = { provider, status: res.status, providerCode: e.error_subcode ? `${code}/${e.error_subcode}` : String(code || res.status) };
    if (code === 190 || code === 102) return new ConnectorError("AUTH_EXPIRED", msg, details);
    if (RATE_LIMIT_CODES.has(code) || res.status === 429) return new ConnectorError("RATE_LIMITED", msg, { ...details, retryAfterMs: 60_000 });
    if (code === 10 || (code >= 200 && code <= 299) || code === 368 || res.status === 403) return new ConnectorError("PERMISSION_DENIED", msg, details);
    if (code === 100 && e.error_subcode === 33) return new ConnectorError("NOT_FOUND", msg, details);
    if (e.is_transient || code === 1 || code === 2 || res.status >= 500) return new ConnectorError("PROVIDER_UNAVAILABLE", msg, details);
    if (res.status === 404) return new ConnectorError("NOT_FOUND", msg, details);
    return new ConnectorError("VALIDATION", msg, details);
  };
}

/** Graph call with the given token (user token by default) and appsecret_proof. */
export async function graph<T>(
  ctx: ConnectorContext,
  method: "GET" | "POST" | "DELETE",
  path: string,
  params: Record<string, string | number | boolean | undefined> = {},
  token = String(ctx.credentials.accessToken),
): Promise<T> {
  const clean = Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)]));
  const auth = { access_token: token, appsecret_proof: appSecretProof(token) };
  const res = await ctx.http.request<T>(
    method === "GET" || method === "DELETE"
      ? { method, url: `${graphBase()}/${path}`, query: { ...clean, ...auth } }
      : { method, url: `${graphBase()}/${path}`, form: { ...clean, ...auth } },
  );
  return res.data;
}

export interface MetaPage {
  id: string;
  name: string;
  category?: string;
  tasks?: string[];
  access_token?: string;
  instagram_business_account?: { id: string; username?: string; name?: string };
}

/** Pages the user manages (follows paging, max 500). Includes page tokens: callers must not return them. */
export async function managedPages(ctx: ConnectorContext, fields = "id,name,category,tasks,access_token,instagram_business_account{id,username,name}"): Promise<MetaPage[]> {
  const pages: MetaPage[] = [];
  let after: string | undefined;
  for (let i = 0; i < 5; i++) {
    const r = await graph<{ data: MetaPage[]; paging?: { cursors?: { after?: string }; next?: string } }>(ctx, "GET", "me/accounts", { fields, limit: 100, after });
    pages.push(...r.data);
    if (!r.paging?.next) break;
    after = r.paging.cursors?.after;
  }
  return pages;
}

export async function pageToken(ctx: ConnectorContext, pageId: string): Promise<string> {
  const page = (await managedPages(ctx, "id,access_token,tasks")).find((p) => p.id === pageId);
  if (!page?.access_token) throw new ConnectorError("NOT_FOUND", "This Facebook Page is not managed by the connected account (or access was not granted to it)", { provider: "meta" });
  return page.access_token;
}

export const publicPage = (p: MetaPage) => ({
  page_id: p.id,
  name: p.name,
  category: p.category ?? null,
  can_post: p.tasks ? p.tasks.includes("CREATE_CONTENT") : null,
  instagram: p.instagram_business_account ? { ig_user_id: p.instagram_business_account.id, username: p.instagram_business_account.username ?? null } : null,
});
