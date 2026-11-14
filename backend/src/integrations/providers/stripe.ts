import { createHmac } from "node:crypto";
import { z } from "zod";
import { safeEqual } from "../../security/crypto.js";
import { ConnectorError } from "../core/errors.js";
import type { ConnectorContext, ConnectorDefinition } from "../core/types.js";
import { stripeForm } from "./shared.js";

/**
 * Stripe API — https://docs.stripe.com/api
 * Auth: restricted API key (recommended) created by the user; stored encrypted.
 * Writes send an Idempotency-Key derived from the workflow execution + step, so retries never
 * create duplicates. Webhooks: endpoint created via API per connection; Stripe-Signature
 * "t=<ts>,v1=<hmac>" verified with the endpoint secret, 5-minute tolerance.
 */
const API = "https://api.stripe.com/v1";
const auth = (ctx: ConnectorContext) => ({ Authorization: `Bearer ${ctx.credentials.apiKey}` });
const TOLERANCE_S = 300;
export const STRIPE_EVENTS = ["payment_intent.succeeded", "payment_intent.payment_failed"];

export function stripeSignatureHeader(secret: string, payload: string, t = Math.floor(Date.now() / 1000)) {
  return `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${payload}`).digest("hex")}`;
}

export function verifyStripeSignature(header: string | undefined, payload: string, secret: string, now = Date.now() / 1000): boolean {
  if (!header) return false;
  const parts = header.split(",").map((p) => p.split("=") as [string, string]);
  const t = parts.find(([k]) => k === "t")?.[1];
  const sigs = parts.filter(([k]) => k === "v1").map(([, v]) => v);
  if (!t || !/^\d+$/.test(t) || sigs.length === 0) return false;
  if (Math.abs(now - Number(t)) > TOLERANCE_S) return false;
  const expected = createHmac("sha256", secret).update(`${t}.${payload}`).digest("hex");
  return sigs.some((s) => safeEqual(s, expected));
}

interface StripeIntent {
  id: string;
  amount: number;
  amount_received?: number;
  currency: string;
  status: string;
  customer: string | null;
  description?: string | null;
  metadata?: Record<string, string>;
  last_payment_error?: { message?: string; code?: string } | null;
  livemode: boolean;
}
const intent = (p: StripeIntent) => ({
  payment_intent_id: p.id,
  amount: p.amount,
  amount_received: p.amount_received ?? null,
  currency: p.currency,
  status: p.status,
  customer: p.customer,
  description: p.description ?? null,
  metadata: p.metadata ?? {},
  failure_message: p.last_payment_error?.message ?? null,
  livemode: p.livemode,
});

export const stripe: ConnectorDefinition = {
  id: "stripe",
  name: "Stripe",
  description: "Create customers and payment links, and react to payments.",
  category: "payments",
  auth: { type: "api_key", label: "Restricted API key", hint: "Create a restricted key in the Stripe Dashboard (Developers → API keys) with only the permissions you need." },
  rateLimit: { note: "100 read and 100 write requests per second in live mode; 429 is retried with backoff." },

  mapError(res) {
    const e = (res.data as { error?: { type?: string; code?: string; message?: string } })?.error ?? {};
    const details = { provider: "stripe", status: res.status, providerCode: e.code ?? e.type };
    const msg = e.message ?? `HTTP ${res.status}`;
    if (res.status === 401) return new ConnectorError("AUTH_REVOKED", "Invalid API key", details);
    if (res.status === 403) return new ConnectorError("PERMISSION_DENIED", msg, details);
    if (res.status === 404) return new ConnectorError("NOT_FOUND", msg, details);
    if (res.status === 429) return new ConnectorError("RATE_LIMITED", msg, details);
    if (res.status >= 500) return new ConnectorError("PROVIDER_UNAVAILABLE", msg, details);
    return new ConnectorError("VALIDATION", msg, details);
  },

  async test(ctx) {
    try {
      const r = await ctx.http.request<{ id: string; settings?: { dashboard?: { display_name?: string } }; business_profile?: { name?: string } }>({ url: `${API}/account`, headers: auth(ctx) });
      return { accountId: r.data.id, accountName: r.data.settings?.dashboard?.display_name ?? r.data.business_profile?.name ?? r.data.id };
    } catch (err) {
      // Restricted keys may not read the account object; a successful list proves the key works.
      if (err instanceof ConnectorError && err.code === "PERMISSION_DENIED") {
        await ctx.http.request({ url: `${API}/customers`, headers: auth(ctx), query: { limit: 1 } });
        return { accountName: "Stripe account" };
      }
      throw err;
    }
  },

  actions: {
    create_customer: {
      key: "create_customer",
      name: "Create customer",
      description: "Create a Stripe customer.",
      input: z.object({ email: z.string().email().max(512).optional(), name: z.string().max(256).optional(), phone: z.string().max(20).optional(), description: z.string().max(350).optional(), metadata: z.record(z.string().max(40), z.string().max(500)).optional() }),
      async run(ctx, i) {
        const r = await ctx.http.request<{ id: string; email: string | null; name: string | null; created: number }>({ method: "POST", url: `${API}/customers`, headers: auth(ctx), form: stripeForm(i), idempotencyKey: ctx.idempotencyKey });
        return { customer_id: r.data.id, email: r.data.email, name: r.data.name, created: r.data.created };
      },
    },
    create_payment_link: {
      key: "create_payment_link",
      name: "Create payment link",
      description: "Create a shareable payment link for an existing price.",
      input: z.object({ price_id: z.string().regex(/^price_[A-Za-z0-9]+$/), quantity: z.number().int().min(1).max(10_000).default(1), redirect_url: z.string().url().optional() }),
      async run(ctx, i) {
        const r = await ctx.http.request<{ id: string; url: string; active: boolean }>({
          method: "POST",
          url: `${API}/payment_links`,
          headers: auth(ctx),
          form: stripeForm({ line_items: [{ price: i.price_id, quantity: i.quantity }], ...(i.redirect_url ? { after_completion: { type: "redirect", redirect: { url: i.redirect_url } } } : {}) }),
          idempotencyKey: ctx.idempotencyKey,
        });
        return { payment_link_id: r.data.id, url: r.data.url, active: r.data.active };
      },
    },
    get_payment: {
      key: "get_payment",
      name: "Retrieve payment",
      description: "Get the status and amount of a PaymentIntent.",
      input: z.object({ payment_intent_id: z.string().regex(/^pi_[A-Za-z0-9]+$/) }),
      async run(ctx, i) {
        const r = await ctx.http.request<StripeIntent>({ url: `${API}/payment_intents/${i.payment_intent_id}`, headers: auth(ctx) });
        return intent(r.data);
      },
    },
  },

  triggers: {
    payment_succeeded: { key: "payment_succeeded", name: "Payment succeeded", description: "Starts when a PaymentIntent succeeds.", mode: "webhook", config: z.object({}), matches: () => true, sample: { payment_intent_id: "pi_123", amount: 1900, currency: "usd", status: "succeeded", customer: "cus_123", livemode: false } },
    payment_failed: { key: "payment_failed", name: "Payment failed", description: "Starts when a payment attempt fails.", mode: "webhook", config: z.object({}), matches: () => true, sample: { payment_intent_id: "pi_123", amount: 1900, currency: "usd", status: "requires_payment_method", failure_message: "Your card was declined.", livemode: false } },
  },

  webhook: {
    routing: "per-connection",
    verify: (req, secret) => !!secret && verifyStripeSignature(req.headers["stripe-signature"], req.rawBody.toString("utf8"), secret),
    parse(req) {
      const event = JSON.parse(req.rawBody.toString("utf8")) as { id: string; type: string; account?: string };
      return { dedupeKey: event.id, eventType: event.type, payload: event };
    },
    toEvents(payload, eventType) {
      const e = payload as { id: string; data: { object: StripeIntent } };
      if (eventType === "payment_intent.succeeded") return [{ trigger: "payment_succeeded", id: e.id, data: intent(e.data.object) }];
      if (eventType === "payment_intent.payment_failed") return [{ trigger: "payment_failed", id: e.id, data: intent(e.data.object) }];
      return [];
    },
    async subscribe(ctx, { url }) {
      const r = await ctx.http.request<{ id: string; secret: string }>({
        method: "POST",
        url: `${API}/webhook_endpoints`,
        headers: auth(ctx),
        form: stripeForm({ url, enabled_events: STRIPE_EVENTS, description: "Telzyra workflows" }),
        idempotencyKey: `tz-webhook-${ctx.connection.id}-${url.slice(-12)}`,
      });
      return { externalId: r.data.id, signingSecret: r.data.secret };
    },
    async unsubscribe(ctx, externalId) {
      if (externalId) await ctx.http.request({ method: "DELETE", url: `${API}/webhook_endpoints/${externalId}`, headers: auth(ctx) });
    },
  },
};
