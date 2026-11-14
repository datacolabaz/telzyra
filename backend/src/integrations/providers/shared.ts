import { ConnectorError } from "../core/errors.js";
import type { HttpClientOptions, HttpResponse } from "../core/http.js";
import type { ConnectorContext } from "../core/types.js";

export type { ConnectorContext, ConnectorDefinition } from "../core/types.js";
export type HttpClientMapError = NonNullable<HttpClientOptions["mapError"]>;

/** Google APIs error format: { error: { code, message, status, errors:[{reason}] } } */
export const googleMapError = (provider: string) => (res: HttpResponse) => {
  const e = (res.data as { error?: { code?: number; message?: string; status?: string; errors?: Array<{ reason?: string }> } })?.error ?? {};
  const reason = e.errors?.[0]?.reason ?? e.status;
  const details = { provider, status: res.status, providerCode: reason };
  const msg = e.message ?? `HTTP ${res.status}`;
  if (res.status === 429 || reason === "RESOURCE_EXHAUSTED" || reason === "rateLimitExceeded" || reason === "userRateLimitExceeded") return new ConnectorError("RATE_LIMITED", msg, details);
  if (res.status === 401) return new ConnectorError("AUTH_EXPIRED", msg, details);
  if (res.status === 403) return new ConnectorError("PERMISSION_DENIED", msg, details);
  if (res.status === 404) return new ConnectorError("NOT_FOUND", msg, details);
  if (res.status === 400) return new ConnectorError("VALIDATION", msg, details);
  if (res.status >= 500) return new ConnectorError("PROVIDER_UNAVAILABLE", msg, details);
  return new ConnectorError("UNKNOWN", msg, details);
};

export async function googleIdentity(ctx: ConnectorContext) {
  const res = await ctx.http.request<{ sub: string; email?: string }>({
    url: "https://openidconnect.googleapis.com/v1/userinfo",
    headers: { Authorization: `Bearer ${ctx.credentials.accessToken}` },
  });
  return { accountId: res.data.sub, accountName: res.data.email ?? "Google account" };
}

/** Encodes nested objects the way Stripe expects: a[b][0][c]=v */
export function stripeForm(input: Record<string, unknown>, prefix = ""): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(input)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (Array.isArray(v)) v.forEach((item, i) => (typeof item === "object" && item !== null ? Object.assign(out, stripeForm(item as Record<string, unknown>, `${key}[${i}]`)) : (out[`${key}[${i}]`] = String(item))));
    else if (typeof v === "object") Object.assign(out, stripeForm(v as Record<string, unknown>, key));
    else out[key] = String(v);
  }
  return out;
}
