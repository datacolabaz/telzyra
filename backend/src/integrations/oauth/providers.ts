import { createHmac } from "node:crypto";
import { env } from "../../config/env.js";
import { safeEqual } from "../../security/crypto.js";
import { HttpClient } from "../core/http.js";
import { ConnectorError } from "../core/errors.js";
import { OAuthError, type OAuthProvider, type TokenSet } from "./types.js";

/**
 * OAuth adapters, one per identity provider. Endpoints follow each provider's official docs:
 *  Google   https://developers.google.com/identity/protocols/oauth2/web-server
 *  Slack    https://api.slack.com/authentication/oauth-v2
 *  Notion   https://developers.notion.com/docs/authorization
 *  HubSpot  https://developers.hubspot.com/docs/api/oauth-quickstart-guide
 *  Shopify  https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/authorization-code-grant
 *  Meta     https://developers.facebook.com/docs/facebook-login/guides/advanced/manual-flow
 */
const http = (provider: string) => new HttpClient({ provider: `${provider}-oauth`, breakerKey: `${provider}-oauth` });

function expiresAt(expiresIn: unknown): Date | null {
  const n = Number(expiresIn);
  return Number.isFinite(n) && n > 0 ? new Date(Date.now() + n * 1000) : null;
}

/** Turns a failed token endpoint call into invalid_grant (reauthorize) or a generic exchange error. */
function tokenError(err: unknown): never {
  if (err instanceof ConnectorError && (err.details.providerCode === "invalid_grant" || err.code === "AUTH_EXPIRED" || err.code === "VALIDATION")) {
    throw new OAuthError("oauth.invalid_grant", err.message);
  }
  throw new OAuthError("oauth.exchange_failed", err instanceof Error ? err.message : "token request failed");
}

const oauthErrorMapper = (provider: string) => (res: { status: number; data: unknown }) => {
  const d = (res.data ?? {}) as { error?: string; error_description?: string; message?: string };
  const code = d.error === "invalid_grant" ? "VALIDATION" : res.status >= 500 ? "PROVIDER_UNAVAILABLE" : "VALIDATION";
  return new ConnectorError(code, d.error_description ?? d.message ?? d.error ?? `HTTP ${res.status}`, {
    provider,
    status: res.status,
    providerCode: d.error,
  });
};

// ─────────────────────────────── Google ───────────────────────────────
export const google: OAuthProvider = {
  id: "google",
  pkce: true,
  requiredEnv: ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"],
  clientId: () => env.GOOGLE_CLIENT_ID ?? "",
  clientSecret: () => env.GOOGLE_CLIENT_SECRET ?? "",
  authorizeUrl(p) {
    const u = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    u.search = new URLSearchParams({
      client_id: p.clientId,
      redirect_uri: p.redirectUri,
      response_type: "code",
      scope: p.scopes.join(" "),
      access_type: "offline", // refresh token
      prompt: "consent", // always return a refresh token, also on reauthorization
      include_granted_scopes: "true",
      state: p.state,
      code_challenge: p.codeChallenge!,
      code_challenge_method: "S256",
    }).toString();
    return u.toString();
  },
  async exchange({ code, redirectUri, codeVerifier }) {
    const res = await new HttpClient({ provider: "google-oauth", breakerKey: "google-oauth", mapError: oauthErrorMapper("google") })
      .request<{ access_token: string; refresh_token?: string; expires_in?: number; scope?: string }>({
        method: "POST",
        url: "https://oauth2.googleapis.com/token",
        form: { code, client_id: this.clientId(), client_secret: this.clientSecret(), redirect_uri: redirectUri, grant_type: "authorization_code", code_verifier: codeVerifier },
      })
      .catch(tokenError);
    return { accessToken: res.data.access_token, refreshToken: res.data.refresh_token, expiresAt: expiresAt(res.data.expires_in), scopes: (res.data.scope ?? "").split(" ").filter(Boolean) };
  },
  async refresh(refreshToken) {
    const res = await new HttpClient({ provider: "google-oauth", breakerKey: "google-oauth", mapError: oauthErrorMapper("google") })
      .request<{ access_token: string; expires_in?: number; scope?: string; refresh_token?: string }>({
        method: "POST",
        url: "https://oauth2.googleapis.com/token",
        form: { client_id: this.clientId(), client_secret: this.clientSecret(), refresh_token: refreshToken, grant_type: "refresh_token" },
        retryNonIdempotent: true,
      })
      .catch(tokenError);
    return { accessToken: res.data.access_token, refreshToken: res.data.refresh_token ?? refreshToken, expiresAt: expiresAt(res.data.expires_in), scopes: (res.data.scope ?? "").split(" ").filter(Boolean) };
  },
  async revoke({ refreshToken, accessToken }) {
    await http("google").request({ method: "POST", url: "https://oauth2.googleapis.com/revoke", form: { token: refreshToken ?? accessToken } });
  },
  async identify(tokens) {
    const res = await http("google").request<{ sub: string; email?: string; name?: string }>({
      url: "https://openidconnect.googleapis.com/v1/userinfo",
      headers: { Authorization: `Bearer ${tokens.accessToken}` },
    });
    return { externalAccountId: res.data.sub, displayName: res.data.email ?? res.data.name ?? "Google account" };
  },
};

// ─────────────────────────────── Slack ───────────────────────────────
interface SlackTokenResponse {
  ok: boolean;
  error?: string;
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  bot_user_id?: string;
  app_id?: string;
  team?: { id: string; name: string };
}
function slackTokens(d: SlackTokenResponse, previous?: Record<string, unknown>): TokenSet {
  return {
    accessToken: d.access_token,
    refreshToken: d.refresh_token,
    expiresAt: expiresAt(d.expires_in),
    scopes: (d.scope ?? "").split(",").filter(Boolean),
    extra: { teamId: d.team?.id ?? previous?.teamId, teamName: d.team?.name ?? previous?.teamName, botUserId: d.bot_user_id ?? previous?.botUserId },
  };
}
const slackHttp = () =>
  new HttpClient({ provider: "slack-oauth", breakerKey: "slack-oauth", isErrorBody: (d) => (d as { ok?: boolean })?.ok === false });

export const slack: OAuthProvider = {
  id: "slack",
  pkce: false,
  httpsRedirectOnly: true,
  requiredEnv: ["SLACK_CLIENT_ID", "SLACK_CLIENT_SECRET", "SLACK_SIGNING_SECRET"],
  clientId: () => env.SLACK_CLIENT_ID ?? "",
  clientSecret: () => env.SLACK_CLIENT_SECRET ?? "",
  authorizeUrl(p) {
    const u = new URL("https://slack.com/oauth/v2/authorize");
    u.search = new URLSearchParams({ client_id: p.clientId, scope: p.scopes.join(","), redirect_uri: p.redirectUri, state: p.state }).toString();
    return u.toString();
  },
  async exchange({ code, redirectUri }) {
    const res = await slackHttp()
      .request<SlackTokenResponse>({ method: "POST", url: "https://slack.com/api/oauth.v2.access", form: { client_id: this.clientId(), client_secret: this.clientSecret(), code, redirect_uri: redirectUri } })
      .catch(tokenError);
    return slackTokens(res.data);
  },
  async refresh(refreshToken, extra) {
    // Only used when token rotation is enabled for the Slack app.
    const res = await slackHttp()
      .request<SlackTokenResponse>({
        method: "POST",
        url: "https://slack.com/api/oauth.v2.access",
        form: { client_id: this.clientId(), client_secret: this.clientSecret(), grant_type: "refresh_token", refresh_token: refreshToken },
        retryNonIdempotent: true,
      })
      .catch(tokenError);
    return slackTokens(res.data, extra);
  },
  async revoke({ accessToken }) {
    await slackHttp().request({ method: "POST", url: "https://slack.com/api/auth.revoke", headers: { Authorization: `Bearer ${accessToken}` } });
  },
  async identify(tokens) {
    const teamId = String(tokens.extra?.teamId ?? "");
    if (!teamId) throw new OAuthError("oauth.exchange_failed", "Slack did not return a team");
    return { externalAccountId: teamId, displayName: String(tokens.extra?.teamName ?? teamId) };
  },
};

// ─────────────────────────────── Notion ───────────────────────────────
interface NotionTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  bot_id?: string;
  workspace_id: string;
  workspace_name?: string;
}
const notionBasic = () => `Basic ${Buffer.from(`${env.NOTION_CLIENT_ID}:${env.NOTION_CLIENT_SECRET}`).toString("base64")}`;
function notionTokens(d: NotionTokenResponse, previous?: Record<string, unknown>): TokenSet {
  return {
    accessToken: d.access_token,
    refreshToken: d.refresh_token,
    expiresAt: expiresAt(d.expires_in),
    scopes: [], // Notion grants access per page/database chosen by the user, not by scope strings
    extra: { workspaceId: d.workspace_id ?? previous?.workspaceId, workspaceName: d.workspace_name ?? previous?.workspaceName, botId: d.bot_id ?? previous?.botId },
  };
}
export const notion: OAuthProvider = {
  id: "notion",
  pkce: false,
  requiredEnv: ["NOTION_CLIENT_ID", "NOTION_CLIENT_SECRET"],
  clientId: () => env.NOTION_CLIENT_ID ?? "",
  clientSecret: () => env.NOTION_CLIENT_SECRET ?? "",
  authorizeUrl(p) {
    const u = new URL("https://api.notion.com/v1/oauth/authorize");
    u.search = new URLSearchParams({ client_id: p.clientId, response_type: "code", owner: "user", redirect_uri: p.redirectUri, state: p.state }).toString();
    return u.toString();
  },
  async exchange({ code, redirectUri }) {
    const res = await new HttpClient({ provider: "notion-oauth", breakerKey: "notion-oauth", mapError: oauthErrorMapper("notion") })
      .request<NotionTokenResponse>({ method: "POST", url: "https://api.notion.com/v1/oauth/token", headers: { Authorization: notionBasic() }, json: { grant_type: "authorization_code", code, redirect_uri: redirectUri } })
      .catch(tokenError);
    return notionTokens(res.data);
  },
  async refresh(refreshToken, extra) {
    const res = await new HttpClient({ provider: "notion-oauth", breakerKey: "notion-oauth", mapError: oauthErrorMapper("notion") })
      .request<NotionTokenResponse>({ method: "POST", url: "https://api.notion.com/v1/oauth/token", headers: { Authorization: notionBasic() }, json: { grant_type: "refresh_token", refresh_token: refreshToken }, retryNonIdempotent: true })
      .catch(tokenError);
    return notionTokens(res.data, extra);
  },
  async revoke({ accessToken }) {
    await http("notion").request({ method: "POST", url: "https://api.notion.com/v1/oauth/revoke", headers: { Authorization: notionBasic() }, json: { token: accessToken } });
  },
  async identify(tokens) {
    const id = String(tokens.extra?.workspaceId ?? "");
    if (!id) throw new OAuthError("oauth.exchange_failed", "Notion did not return a workspace");
    return { externalAccountId: id, displayName: String(tokens.extra?.workspaceName ?? "Notion workspace") };
  },
};

// ─────────────────────────────── HubSpot ───────────────────────────────
export const hubspot: OAuthProvider = {
  id: "hubspot",
  pkce: false,
  requiredEnv: ["HUBSPOT_CLIENT_ID", "HUBSPOT_CLIENT_SECRET"],
  clientId: () => env.HUBSPOT_CLIENT_ID ?? "",
  clientSecret: () => env.HUBSPOT_CLIENT_SECRET ?? "",
  authorizeUrl(p) {
    const u = new URL("https://app.hubspot.com/oauth/authorize");
    u.search = new URLSearchParams({ client_id: p.clientId, redirect_uri: p.redirectUri, scope: p.scopes.join(" "), state: p.state }).toString();
    return u.toString();
  },
  async exchange({ code, redirectUri }) {
    const res = await new HttpClient({ provider: "hubspot-oauth", breakerKey: "hubspot-oauth", mapError: oauthErrorMapper("hubspot") })
      .request<{ access_token: string; refresh_token: string; expires_in: number }>({
        method: "POST",
        url: "https://api.hubapi.com/oauth/v1/token",
        form: { grant_type: "authorization_code", client_id: this.clientId(), client_secret: this.clientSecret(), redirect_uri: redirectUri, code },
      })
      .catch(tokenError);
    return { accessToken: res.data.access_token, refreshToken: res.data.refresh_token, expiresAt: expiresAt(res.data.expires_in), scopes: [] };
  },
  async refresh(refreshToken) {
    const res = await new HttpClient({ provider: "hubspot-oauth", breakerKey: "hubspot-oauth", mapError: oauthErrorMapper("hubspot") })
      .request<{ access_token: string; refresh_token: string; expires_in: number }>({
        method: "POST",
        url: "https://api.hubapi.com/oauth/v1/token",
        form: { grant_type: "refresh_token", client_id: this.clientId(), client_secret: this.clientSecret(), refresh_token: refreshToken },
        retryNonIdempotent: true,
      })
      .catch(tokenError);
    return { accessToken: res.data.access_token, refreshToken: res.data.refresh_token ?? refreshToken, expiresAt: expiresAt(res.data.expires_in), scopes: [] };
  },
  async revoke({ refreshToken }) {
    if (refreshToken) await http("hubspot").request({ method: "DELETE", url: `https://api.hubapi.com/oauth/v1/refresh-tokens/${encodeURIComponent(refreshToken)}` });
  },
  async identify(tokens) {
    const res = await http("hubspot").request<{ hub_id: number; hub_domain?: string; scopes?: string[] }>({
      url: `https://api.hubapi.com/oauth/v1/access-tokens/${encodeURIComponent(tokens.accessToken)}`,
    });
    tokens.scopes = res.data.scopes ?? [];
    tokens.extra = { ...tokens.extra, portalId: String(res.data.hub_id) };
    return { externalAccountId: String(res.data.hub_id), displayName: res.data.hub_domain ?? `HubSpot ${res.data.hub_id}` };
  },
};

// ─────────────────────────────── Shopify ───────────────────────────────
export const SHOP_DOMAIN = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;

/** HMAC over the sorted query string (without hmac/signature), hex, keyed with the app secret. */
export function shopifyQueryHmac(query: Record<string, string>, secret: string): string {
  const message = Object.keys(query)
    .filter((k) => k !== "hmac" && k !== "signature")
    .sort()
    .map((k) => `${k}=${query[k]}`)
    .join("&");
  return createHmac("sha256", secret).update(message).digest("hex");
}

export const shopify: OAuthProvider = {
  id: "shopify",
  pkce: false,
  httpsRedirectOnly: true,
  requiredEnv: ["SHOPIFY_CLIENT_ID", "SHOPIFY_CLIENT_SECRET"],
  clientId: () => env.SHOPIFY_CLIENT_ID ?? "",
  clientSecret: () => env.SHOPIFY_CLIENT_SECRET ?? "",
  startParams(input) {
    const shop = String(input.shop ?? "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
    if (!SHOP_DOMAIN.test(shop)) throw new OAuthError("oauth.invalid_request", "A valid *.myshopify.com domain is required");
    return { shop };
  },
  authorizeUrl(p) {
    const u = new URL(`https://${p.extra.shop}/admin/oauth/authorize`);
    u.search = new URLSearchParams({ client_id: p.clientId, scope: p.scopes.join(","), redirect_uri: p.redirectUri, state: p.state }).toString();
    return u.toString();
  },
  verifyCallback(query, extra) {
    if (!query.hmac || !safeEqual(shopifyQueryHmac(query, this.clientSecret()), query.hmac)) throw new OAuthError("oauth.invalid_request", "Invalid Shopify HMAC");
    if (query.shop !== extra.shop) throw new OAuthError("oauth.invalid_request", "Shop mismatch");
  },
  async exchange({ code, extra }) {
    const res = await new HttpClient({ provider: "shopify-oauth", breakerKey: "shopify-oauth", mapError: oauthErrorMapper("shopify") })
      .request<{ access_token: string; scope: string }>({
        method: "POST",
        url: `https://${extra.shop}/admin/oauth/access_token`,
        json: { client_id: this.clientId(), client_secret: this.clientSecret(), code },
      })
      .catch(tokenError);
    return { accessToken: res.data.access_token, scopes: res.data.scope.split(",").filter(Boolean), extra: { shop: extra.shop } };
  },
  async revoke({ accessToken }, extra) {
    await http("shopify").request({ method: "DELETE", url: `https://${extra.shop}/admin/api_permissions/current.json`, headers: { "X-Shopify-Access-Token": accessToken ?? "" } });
  },
  async identify(tokens) {
    const shop = String(tokens.extra?.shop ?? "");
    return { externalAccountId: shop, displayName: shop };
  },
};


// ─────────────────────────────── Meta (Facebook Login for Business) ───────────────────────────────
const metaHttp = () =>
  new HttpClient({
    provider: "meta-oauth",
    breakerKey: "meta-oauth",
    mapError: (res) => {
      const e = (res.data as { error?: { message?: string; code?: number; type?: string } })?.error ?? {};
      return new ConnectorError(e.code === 190 || e.code === 100 ? "VALIDATION" : res.status >= 500 ? "PROVIDER_UNAVAILABLE" : "VALIDATION", e.message ?? `HTTP ${res.status}`, { provider: "meta", status: res.status, providerCode: String(e.code ?? "") });
    },
  });
const metaGraph = () => `https://graph.facebook.com/${env.META_GRAPH_VERSION}`;
const metaProof = (token: string) => createHmac("sha256", env.META_APP_SECRET ?? "").update(token).digest("hex");

export const meta: OAuthProvider = {
  id: "meta",
  pkce: false,
  requiredEnv: ["META_APP_ID", "META_APP_SECRET"],
  clientId: () => env.META_APP_ID ?? "",
  clientSecret: () => env.META_APP_SECRET ?? "",
  authorizeUrl(p) {
    const u = new URL(`https://www.facebook.com/${env.META_GRAPH_VERSION}/dialog/oauth`);
    u.search = new URLSearchParams({ client_id: p.clientId, redirect_uri: p.redirectUri, state: p.state, response_type: "code", scope: p.scopes.join(",") }).toString();
    return u.toString();
  },
  async exchange({ code, redirectUri }) {
    const short = await metaHttp()
      .request<{ access_token: string; expires_in?: number }>({ url: `${metaGraph()}/oauth/access_token`, query: { client_id: this.clientId(), client_secret: this.clientSecret(), redirect_uri: redirectUri, code } })
      .catch(tokenError);
    // Exchange for a long-lived user token (~60 days); Meta issues no refresh token.
    const long = await metaHttp()
      .request<{ access_token: string; expires_in?: number }>({ url: `${metaGraph()}/oauth/access_token`, query: { grant_type: "fb_exchange_token", client_id: this.clientId(), client_secret: this.clientSecret(), fb_exchange_token: short.data.access_token } })
      .catch(tokenError);
    const token = long.data.access_token;
    // Granular consent: report only what the user actually granted, so missing scopes are detected.
    const perms = await metaHttp().request<{ data: Array<{ permission: string; status: string }> }>({ url: `${metaGraph()}/me/permissions`, query: { access_token: token, appsecret_proof: metaProof(token) } });
    return {
      accessToken: token,
      expiresAt: expiresAt(long.data.expires_in ?? 60 * 86_400),
      scopes: perms.data.data.filter((p) => p.status === "granted").map((p) => p.permission),
    };
  },
  async revoke({ accessToken }) {
    if (!accessToken) return;
    await metaHttp().request({ method: "DELETE", url: `${metaGraph()}/me/permissions`, query: { access_token: accessToken, appsecret_proof: metaProof(accessToken) } });
  },
  async identify(tokens) {
    const r = await metaHttp().request<{ id: string; name?: string }>({ url: `${metaGraph()}/me`, query: { fields: "id,name", access_token: tokens.accessToken, appsecret_proof: metaProof(tokens.accessToken) } });
    return { externalAccountId: r.data.id, displayName: r.data.name ?? "Meta account" };
  },
};

const PROVIDERS = new Map<string, OAuthProvider>([google, slack, notion, hubspot, shopify, meta].map((p) => [p.id, p]));

export function getOAuthProvider(id: string): OAuthProvider | undefined {
  return PROVIDERS.get(id);
}
