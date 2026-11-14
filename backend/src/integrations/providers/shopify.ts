import { createHmac } from "node:crypto";
import { z } from "zod";
import { env } from "../../config/env.js";
import { safeEqual } from "../../security/crypto.js";
import { ConnectorError } from "../core/errors.js";
import type { ConnectorContext, ConnectorDefinition } from "../core/types.js";

/**
 * Shopify Admin GraphQL API — https://shopify.dev/docs/api/admin-graphql
 * API version from SHOPIFY_API_VERSION (default 2026-10). Auth: per-shop OAuth, offline token.
 * Webhooks: webhookSubscriptionCreate with `uri` (callbackUrl is deprecated); deliveries are signed
 * with X-Shopify-Hmac-Sha256 = base64(HMAC-SHA256(app secret, body)).
 * Order data is "protected customer data": public apps need Shopify's approval to read it.
 * Rate limit: cost-based (query cost points); THROTTLED errors are retried.
 */
const gqlUrl = (ctx: ConnectorContext) => `https://${String(ctx.credentials.shop)}/admin/api/${env.SHOPIFY_API_VERSION}/graphql.json`;

interface GqlResponse<T> {
  data?: T;
  errors?: Array<{ message: string; extensions?: { code?: string } }>;
}

async function gql<T>(ctx: ConnectorContext, query: string, variables: Record<string, unknown> = {}, opts: { read?: boolean } = {}): Promise<T> {
  const res = await ctx.http.request<GqlResponse<T>>({
    method: "POST",
    url: gqlUrl(ctx),
    headers: { "X-Shopify-Access-Token": String(ctx.credentials.accessToken) },
    json: { query, variables },
    retryNonIdempotent: opts.read,
  });
  return res.data.data as T;
}

function userErrors(errors: Array<{ field?: string[] | null; message: string }> | undefined) {
  if (errors?.length) throw new ConnectorError("VALIDATION", errors.map((e) => e.message).join("; "), { provider: "shopify" });
}

export const shopifyWebhookHmac = (secret: string, body: Buffer | string) => createHmac("sha256", secret).update(body).digest("base64");
const gid = (type: string) => z.string().regex(new RegExp(`^gid://shopify/${type}/\\d+$`), `Expected a ${type} GID`);

const ORDER_FIELDS = `id name createdAt updatedAt displayFinancialStatus displayFulfillmentStatus currencyCode
  totalPriceSet { shopMoney { amount currencyCode } }
  lineItems(first: 50) { edges { node { title quantity sku } } }`;

interface Order {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  displayFinancialStatus: string | null;
  displayFulfillmentStatus: string;
  totalPriceSet: { shopMoney: { amount: string; currencyCode: string } };
  lineItems: { edges: Array<{ node: { title: string; quantity: number; sku: string | null } }> };
}
const order = (o: Order) => ({
  id: o.id,
  name: o.name,
  created_at: o.createdAt,
  updated_at: o.updatedAt,
  financial_status: o.displayFinancialStatus,
  fulfillment_status: o.displayFulfillmentStatus,
  total: o.totalPriceSet.shopMoney.amount,
  currency: o.totalPriceSet.shopMoney.currencyCode,
  line_items: o.lineItems.edges.map((e) => e.node),
});

const TOPICS: Record<string, string> = { "orders/create": "new_order", "orders/updated": "order_updated" };

export const shopify: ConnectorDefinition = {
  id: "shopify",
  name: "Shopify",
  description: "Work with orders, products and inventory in your Shopify store.",
  category: "commerce",
  auth: { type: "oauth2", provider: "shopify", scopes: ["read_orders", "read_products", "read_inventory", "write_inventory", "read_locations"] },
  requiredEnv: ["SHOPIFY_CLIENT_ID", "SHOPIFY_CLIENT_SECRET"],
  rateLimit: { note: "Cost-based GraphQL limits (points restored per second); THROTTLED responses are retried." },

  isErrorBody: (d) => Array.isArray((d as GqlResponse<unknown>)?.errors) && (d as GqlResponse<unknown>).errors!.length > 0,
  mapError(res) {
    const errs = (res.data as GqlResponse<unknown>)?.errors ?? [];
    const code = errs[0]?.extensions?.code;
    const msg = errs.map((e) => e.message).join("; ") || `HTTP ${res.status}`;
    const details = { provider: "shopify", status: res.status, providerCode: code };
    if (code === "THROTTLED" || res.status === 429) return new ConnectorError("RATE_LIMITED", msg, { ...details, retryAfterMs: 1000 });
    if (code === "ACCESS_DENIED" || res.status === 403 || res.status === 402) return new ConnectorError("PERMISSION_DENIED", msg, details);
    if (res.status === 401) return new ConnectorError("AUTH_REVOKED", msg, details);
    if (res.status === 404) return new ConnectorError("NOT_FOUND", msg, details);
    if (res.status >= 500 || code === "INTERNAL_SERVER_ERROR") return new ConnectorError("PROVIDER_UNAVAILABLE", msg, details);
    return new ConnectorError("VALIDATION", msg, details);
  },

  async test(ctx) {
    const d = await gql<{ shop: { name: string; myshopifyDomain: string } }>(ctx, "{ shop { name myshopifyDomain } }", {}, { read: true });
    return { accountId: d.shop.myshopifyDomain, accountName: d.shop.name };
  },

  actions: {
    list_orders: {
      key: "list_orders",
      name: "Retrieve orders",
      description: "List recent orders, optionally filtered with Shopify search syntax.",
      input: z.object({ query: z.string().max(500).optional(), first: z.number().int().min(1).max(100).default(20), after: z.string().max(500).optional() }),
      async run(ctx, i) {
        const d = await gql<{ orders: { edges: Array<{ node: Order }>; pageInfo: { hasNextPage: boolean; endCursor: string | null } } }>(
          ctx,
          `query($first:Int!,$after:String,$query:String){ orders(first:$first, after:$after, query:$query, sortKey:CREATED_AT, reverse:true){ edges{ node{ ${ORDER_FIELDS} } } pageInfo{ hasNextPage endCursor } } }`,
          i,
          { read: true },
        );
        return { orders: d.orders.edges.map((e) => order(e.node)), next_cursor: d.orders.pageInfo.hasNextPage ? d.orders.pageInfo.endCursor : null };
      },
    },
    list_products: {
      key: "list_products",
      name: "Retrieve products",
      description: "List products with variants and inventory item ids.",
      input: z.object({ query: z.string().max(500).optional(), first: z.number().int().min(1).max(100).default(20), after: z.string().max(500).optional() }),
      async run(ctx, i) {
        const d = await gql<{ products: { edges: Array<{ node: { id: string; title: string; status: string; handle: string; totalInventory: number | null; variants: { edges: Array<{ node: { id: string; title: string; sku: string | null; inventoryItem: { id: string } } }> } } }>; pageInfo: { hasNextPage: boolean; endCursor: string | null } } }>(
          ctx,
          `query($first:Int!,$after:String,$query:String){ products(first:$first, after:$after, query:$query){ edges{ node{ id title status handle totalInventory variants(first:50){ edges{ node{ id title sku inventoryItem{ id } } } } } } pageInfo{ hasNextPage endCursor } } }`,
          i,
          { read: true },
        );
        return {
          products: d.products.edges.map(({ node: p }) => ({ id: p.id, title: p.title, status: p.status, handle: p.handle, total_inventory: p.totalInventory, variants: p.variants.edges.map(({ node: v }) => ({ id: v.id, title: v.title, sku: v.sku, inventory_item_id: v.inventoryItem.id })) })),
          next_cursor: d.products.pageInfo.hasNextPage ? d.products.pageInfo.endCursor : null,
        };
      },
    },
    set_inventory: {
      key: "set_inventory",
      name: "Update inventory",
      description: "Set the available quantity of an inventory item at a location.",
      input: z.object({ inventory_item_id: gid("InventoryItem"), location_id: gid("Location"), quantity: z.number().int().min(0).max(1_000_000_000), reason: z.enum(["correction", "cycle_count_available", "received", "restock", "other"]).default("correction") }),
      async run(ctx, i) {
        const d = await gql<{ inventorySetQuantities: { inventoryAdjustmentGroup: { id: string } | null; userErrors: Array<{ field: string[] | null; message: string }> } }>(
          ctx,
          `mutation($input: InventorySetQuantitiesInput!){ inventorySetQuantities(input:$input){ inventoryAdjustmentGroup{ id } userErrors{ field message } } }`,
          { input: { name: "available", reason: i.reason, ignoreCompareQuantity: true, quantities: [{ inventoryItemId: i.inventory_item_id, locationId: i.location_id, quantity: i.quantity }] } },
        );
        userErrors(d.inventorySetQuantities.userErrors);
        return { adjustment_group_id: d.inventorySetQuantities.inventoryAdjustmentGroup?.id ?? null, quantity: i.quantity };
      },
    },
  },

  triggers: {
    new_order: { key: "new_order", name: "New order", description: "Starts when an order is created.", mode: "webhook", config: z.object({}), matches: () => true, sample: { id: 820982911946154500, name: "#1001", total_price: "19.00", currency: "USD", financial_status: "paid" } },
    order_updated: { key: "order_updated", name: "Order updated", description: "Starts when an order changes.", mode: "webhook", config: z.object({}), matches: () => true, sample: { id: 820982911946154500, name: "#1001", financial_status: "refunded" } },
  },

  webhook: {
    routing: "per-connection",
    verify(req) {
      const secret = env.SHOPIFY_CLIENT_SECRET;
      const sig = req.headers["x-shopify-hmac-sha256"];
      return !!secret && !!sig && safeEqual(shopifyWebhookHmac(secret, req.rawBody), sig);
    },
    parse(req) {
      const id = req.headers["x-shopify-event-id"] ?? req.headers["x-shopify-webhook-id"];
      return { dedupeKey: id ?? undefined, eventType: req.headers["x-shopify-topic"], accountId: req.headers["x-shopify-shop-domain"], payload: JSON.parse(req.rawBody.toString("utf8")) };
    },
    toEvents(payload, eventType) {
      const o = payload as { id: number; name?: string; total_price?: string; currency?: string; financial_status?: string; fulfillment_status?: string | null; created_at?: string; updated_at?: string };
      const trigger = eventType ? TOPICS[eventType] : undefined;
      if (!trigger) return [];
      return [{ trigger, id: `${o.id}:${o.updated_at ?? ""}`, data: { id: o.id, name: o.name ?? null, total_price: o.total_price ?? null, currency: o.currency ?? null, financial_status: o.financial_status ?? null, fulfillment_status: o.fulfillment_status ?? null, created_at: o.created_at ?? null, updated_at: o.updated_at ?? null } }];
    },
    async subscribe(ctx, { url, events }) {
      const topics = events.length ? events : ["ORDERS_CREATE", "ORDERS_UPDATED"];
      const ids: string[] = [];
      for (const topic of topics) {
        const d = await gql<{ webhookSubscriptionCreate: { webhookSubscription: { id: string } | null; userErrors: Array<{ field: string[] | null; message: string }> } }>(
          ctx,
          `mutation($topic: WebhookSubscriptionTopic!, $sub: WebhookSubscriptionInput!){ webhookSubscriptionCreate(topic:$topic, webhookSubscription:$sub){ webhookSubscription{ id } userErrors{ field message } } }`,
          { topic, sub: { uri: url, format: "JSON" } },
        );
        userErrors(d.webhookSubscriptionCreate.userErrors);
        if (d.webhookSubscriptionCreate.webhookSubscription) ids.push(d.webhookSubscriptionCreate.webhookSubscription.id);
      }
      return { externalId: ids.join(",") };
    },
    async unsubscribe(ctx, externalId) {
      for (const id of (externalId ?? "").split(",").filter(Boolean)) {
        await gql(ctx, `mutation($id: ID!){ webhookSubscriptionDelete(id:$id){ deletedWebhookSubscriptionId userErrors{ message } } }`, { id });
      }
    },
  },
};
