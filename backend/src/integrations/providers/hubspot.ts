import { createHmac } from "node:crypto";
import { z } from "zod";
import { env } from "../../config/env.js";
import { safeEqual } from "../../security/crypto.js";
import { ConnectorError } from "../core/errors.js";
import type { ConnectorContext, ConnectorDefinition, TriggerEvent } from "../core/types.js";

/**
 * HubSpot CRM API v3 — https://developers.hubspot.com/docs/api/crm/contacts
 * Auth: OAuth (public app). Access tokens last ~30 minutes and are refreshed automatically.
 * Webhooks are configured at app level (not per account); events arrive in batches and are
 * routed by portalId. Signature: X-HubSpot-Signature-v3 = base64(HMAC-SHA256(client secret,
 * method + uri + body + timestamp)), timestamp within 5 minutes.
 */
const API = "https://api.hubapi.com";
const headers = (ctx: ConnectorContext) => ({ Authorization: `Bearer ${ctx.credentials.accessToken}` });
const props = z.record(z.string().max(100), z.union([z.string().max(65_536), z.number(), z.boolean()]));
const REPLAY_WINDOW_MS = 5 * 60 * 1000;

export function hubspotSignatureV3(secret: string, method: string, uri: string, body: string, timestamp: string) {
  return createHmac("sha256", secret).update(`${method}${uri}${body}${timestamp}`).digest("base64");
}

const CATEGORY: Record<string, ConnectorError["code"]> = {
  OBJECT_NOT_FOUND: "NOT_FOUND",
  VALIDATION_ERROR: "VALIDATION",
  INVALID_EMAIL: "VALIDATION",
  CONFLICT: "VALIDATION",
  RATE_LIMITS: "RATE_LIMITED",
  MISSING_SCOPES: "PERMISSION_DENIED",
  EXPIRED_AUTHENTICATION: "AUTH_EXPIRED",
  INVALID_AUTHENTICATION: "AUTH_REVOKED",
};

interface HsObject {
  id: string;
  properties: Record<string, string | null>;
  createdAt?: string;
  updatedAt?: string;
}
const object = (o: HsObject) => ({ id: o.id, properties: o.properties, created_at: o.createdAt ?? null, updated_at: o.updatedAt ?? null });

export const hubspot: ConnectorDefinition = {
  id: "hubspot",
  name: "HubSpot",
  description: "Create and update contacts and deals in HubSpot CRM.",
  category: "crm",
  auth: { type: "oauth2", provider: "hubspot", scopes: ["oauth", "crm.objects.contacts.read", "crm.objects.contacts.write", "crm.objects.deals.read", "crm.objects.deals.write"] },
  requiredEnv: ["HUBSPOT_CLIENT_ID", "HUBSPOT_CLIENT_SECRET"],
  rateLimit: { note: "Public apps: 110 requests per 10 seconds per account; 429 with Retry-After is retried." },

  mapError(res) {
    const d = (res.data ?? {}) as { category?: string; message?: string };
    const code: ConnectorError["code"] = (d.category ? CATEGORY[d.category] : undefined) ?? (res.status === 401 ? "AUTH_EXPIRED" : res.status === 429 ? "RATE_LIMITED" : res.status >= 500 ? "PROVIDER_UNAVAILABLE" : res.status === 404 ? "NOT_FOUND" : "VALIDATION");
    return new ConnectorError(code, d.message ?? `HTTP ${res.status}`, { provider: "hubspot", status: res.status, providerCode: d.category });
  },

  async test(ctx) {
    const r = await ctx.http.request<{ hub_id: number; hub_domain?: string }>({ url: `${API}/oauth/v1/access-tokens/${encodeURIComponent(String(ctx.credentials.accessToken))}` });
    return { accountId: String(r.data.hub_id), accountName: r.data.hub_domain ?? `HubSpot ${r.data.hub_id}` };
  },

  actions: {
    create_contact: {
      key: "create_contact",
      name: "Create contact",
      description: "Create a CRM contact.",
      input: z.object({ email: z.string().email().max(320), firstname: z.string().max(200).optional(), lastname: z.string().max(200).optional(), phone: z.string().max(50).optional(), company: z.string().max(200).optional(), properties: props.optional() }),
      async run(ctx, i) {
        const { properties, ...known } = i;
        const r = await ctx.http.request<HsObject>({ method: "POST", url: `${API}/crm/v3/objects/contacts`, headers: headers(ctx), json: { properties: { ...properties, ...known } } });
        return object(r.data);
      },
    },
    update_contact: {
      key: "update_contact",
      name: "Update contact",
      description: "Update properties of a contact by id.",
      input: z.object({ contact_id: z.string().regex(/^\d+$/), properties: props }),
      async run(ctx, i) {
        const r = await ctx.http.request<HsObject>({ method: "PATCH", url: `${API}/crm/v3/objects/contacts/${i.contact_id}`, headers: headers(ctx), json: { properties: i.properties }, retryNonIdempotent: true });
        return object(r.data);
      },
    },
    search_contacts: {
      key: "search_contacts",
      name: "Search contacts",
      description: "Find contacts by email or free text.",
      input: z.object({ email: z.string().email().optional(), query: z.string().max(200).optional(), limit: z.number().int().min(1).max(100).default(10), after: z.string().max(50).optional() }),
      async run(ctx, i) {
        const r = await ctx.http.request<{ total: number; results: HsObject[]; paging?: { next?: { after: string } } }>({
          method: "POST",
          url: `${API}/crm/v3/objects/contacts/search`,
          headers: headers(ctx),
          json: {
            ...(i.email ? { filterGroups: [{ filters: [{ propertyName: "email", operator: "EQ", value: i.email }] }] } : {}),
            ...(i.query ? { query: i.query } : {}),
            properties: ["email", "firstname", "lastname", "phone", "company"],
            limit: i.limit,
            after: i.after,
          },
          retryNonIdempotent: true, // search is read-only
        });
        return { total: r.data.total, results: r.data.results.map(object), next_after: r.data.paging?.next?.after ?? null };
      },
    },
    create_deal: {
      key: "create_deal",
      name: "Create deal",
      description: "Create a deal, optionally associated with a contact.",
      input: z.object({ dealname: z.string().min(1).max(500), amount: z.union([z.number(), z.string().max(30)]).optional(), pipeline: z.string().max(100).optional(), dealstage: z.string().max(100).optional(), contact_id: z.string().regex(/^\d+$/).optional(), properties: props.optional() }),
      async run(ctx, i) {
        const { contact_id, properties, ...known } = i;
        const r = await ctx.http.request<HsObject>({
          method: "POST",
          url: `${API}/crm/v3/objects/deals`,
          headers: headers(ctx),
          json: {
            properties: { ...properties, ...Object.fromEntries(Object.entries(known).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)])) },
            // 3 = HubSpot-defined association "deal to contact"
            ...(contact_id ? { associations: [{ to: { id: contact_id }, types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 3 }] }] } : {}),
          },
        });
        return object(r.data);
      },
    },
  },

  triggers: {
    contact_created: { key: "contact_created", name: "Contact created", description: "Starts when a contact is created (app webhook).", mode: "webhook", config: z.object({}), matches: () => true, sample: { object_id: "101", portal_id: "123", occurred_at: 1767225600000 } },
    contact_updated: {
      key: "contact_updated",
      name: "Contact property changed",
      description: "Starts when a subscribed contact property changes (app webhook).",
      mode: "webhook",
      config: z.object({ property: z.string().max(100).optional() }),
      matches: (e, c) => !c.property || (e.data as { property?: string }).property === c.property,
      sample: { object_id: "101", portal_id: "123", property: "lifecyclestage", value: "customer", occurred_at: 1767225600000 },
    },
    deal_created: { key: "deal_created", name: "Deal created", description: "Starts when a deal is created (app webhook).", mode: "webhook", config: z.object({}), matches: () => true, sample: { object_id: "202", portal_id: "123", occurred_at: 1767225600000 } },
  },

  webhook: {
    routing: "app",
    verify(req) {
      const secret = env.HUBSPOT_CLIENT_SECRET;
      const sig = req.headers["x-hubspot-signature-v3"];
      const ts = req.headers["x-hubspot-request-timestamp"];
      if (!secret || !sig || !ts || !/^\d+$/.test(ts)) return false;
      if (Math.abs(Date.now() - Number(ts)) > REPLAY_WINDOW_MS) return false;
      return safeEqual(hubspotSignatureV3(secret, req.method, req.url, req.rawBody.toString("utf8"), ts), sig);
    },
    parse(req) {
      const events = JSON.parse(req.rawBody.toString("utf8")) as Array<{ eventId: number; subscriptionType: string; portalId: number; objectId: number; propertyName?: string; propertyValue?: string; occurredAt: number }>;
      return {
        batch: events.map((e) => ({ dedupeKey: String(e.eventId), eventType: e.subscriptionType, accountId: String(e.portalId), payload: e })),
      };
    },
    toEvents(payload, eventType) {
      const e = payload as { eventId: number; portalId: number; objectId: number; propertyName?: string; propertyValue?: string; occurredAt: number };
      const data = { object_id: String(e.objectId), portal_id: String(e.portalId), occurred_at: e.occurredAt, property: e.propertyName ?? null, value: e.propertyValue ?? null };
      const map: Record<string, string> = { "contact.creation": "contact_created", "contact.propertyChange": "contact_updated", "deal.creation": "deal_created" };
      const trigger = eventType ? map[eventType] : undefined;
      return trigger ? ([{ trigger, id: String(e.eventId), data }] satisfies TriggerEvent[]) : [];
    },
  },
};
