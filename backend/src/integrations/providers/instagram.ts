import { z } from "zod";
import { ConnectorError } from "../core/errors.js";
import type { ConnectorContext, ConnectorDefinition } from "../core/types.js";
import { graph, managedPages, metaMapError } from "./meta.js";

/**
 * Instagram (professional accounts: Business or Creator) via Facebook Login for Business.
 * https://developers.facebook.com/docs/instagram-platform/content-publishing
 *
 * Publishing is two-step: create a media container from a PUBLIC media URL (JPEG images; MP4 for
 * reels), wait until status_code is FINISHED, then media_publish. The account's publishing quota
 * (content_publishing_limit) is checked first so a workflow fails clearly instead of hitting Meta's
 * limit. Permissions: instagram_basic, instagram_content_publish, pages_read_engagement (+ pages_show_list).
 */
export const igTiming = { intervalMs: 15_000, maxWaitMs: 5 * 60_000 }; // Meta: poll ≤ once a minute-ish, ≤ 5 min
const igUserId = z.string().regex(/^\d{5,25}$/, "Instagram account id (ig_user_id from List accounts)");
const caption = z.string().max(2_200).optional();
const mediaUrl = z.string().url().refine((u) => u.startsWith("https://"), "Must be a public https URL");

/** Page token of the Facebook Page linked to this Instagram account. */
async function tokenFor(ctx: ConnectorContext, igId: string): Promise<string> {
  const page = (await managedPages(ctx)).find((p) => p.instagram_business_account?.id === igId);
  if (!page?.access_token) throw new ConnectorError("NOT_FOUND", "This Instagram account is not linked to a Facebook Page the connected account manages", { provider: "instagram" });
  return page.access_token;
}

async function assertQuota(ctx: ConnectorContext, igId: string, token: string, needed = 1) {
  const r = await graph<{ data: Array<{ quota_usage?: number; config?: { quota_total?: number } }> }>(ctx, "GET", `${igId}/content_publishing_limit`, { fields: "config,quota_usage" }, token);
  const d = r.data[0];
  const total = d?.config?.quota_total;
  if (total !== undefined && (d?.quota_usage ?? 0) + needed > total) {
    throw new ConnectorError("RATE_LIMITED", `Instagram publishing limit reached (${d?.quota_usage}/${total} posts in 24 hours)`, { provider: "instagram", retryAfterMs: 60 * 60_000 });
  }
}

async function waitUntilReady(ctx: ConnectorContext, containerId: string, token: string) {
  const started = Date.now();
  for (;;) {
    const s = await graph<{ status_code?: string; status?: string }>(ctx, "GET", containerId, { fields: "status_code,status" }, token);
    if (s.status_code === "FINISHED" || s.status_code === "PUBLISHED") return;
    if (s.status_code === "ERROR" || s.status_code === "EXPIRED") throw new ConnectorError("VALIDATION", `Instagram could not process the media (${s.status_code}${s.status ? `: ${s.status}` : ""})`, { provider: "instagram", providerCode: s.status_code });
    if (Date.now() - started > igTiming.maxWaitMs) throw new ConnectorError("TIMEOUT", "Instagram is still processing the media; try again later", { provider: "instagram" });
    await new Promise((r) => setTimeout(r, igTiming.intervalMs));
  }
}

async function publish(ctx: ConnectorContext, igId: string, containerId: string, token: string) {
  await waitUntilReady(ctx, containerId, token);
  const r = await graph<{ id: string }>(ctx, "POST", `${igId}/media_publish`, { creation_id: containerId }, token);
  const media = await graph<{ id: string; permalink?: string; media_type?: string; media_product_type?: string }>(ctx, "GET", r.id, { fields: "id,permalink,media_type,media_product_type" }, token).catch(() => ({ id: r.id }) as { id: string; permalink?: string });
  return { media_id: r.id, permalink: media.permalink ?? null };
}

export const instagram: ConnectorDefinition = {
  id: "instagram",
  name: "Instagram",
  description: "Publish photos, carousels and reels to Instagram Business or Creator accounts.",
  category: "social",
  auth: { type: "oauth2", provider: "meta", scopes: ["instagram_basic", "instagram_content_publish", "pages_show_list", "pages_read_engagement", "business_management"] },
  requiredEnv: ["META_APP_ID", "META_APP_SECRET"],
  rateLimit: { note: "100 API-published posts per account per 24 hours (carousel = 1); checked before publishing." },
  mapError: metaMapError("instagram"),

  async test(ctx) {
    const me = await graph<{ id: string; name: string }>(ctx, "GET", "me", { fields: "id,name" });
    const accounts = (await managedPages(ctx)).filter((p) => p.instagram_business_account);
    if (accounts.length === 0) throw new ConnectorError("NOT_FOUND", "No Instagram Business/Creator account is linked to your Facebook Pages", { provider: "instagram" });
    return { accountId: me.id, accountName: accounts.map((p) => `@${p.instagram_business_account!.username ?? p.instagram_business_account!.id}`).join(", ") };
  },

  actions: {
    list_accounts: {
      key: "list_accounts",
      name: "List accounts",
      description: "Instagram professional accounts linked to your Facebook Pages.",
      input: z.object({}),
      async run(ctx) {
        const pages = await managedPages(ctx);
        return {
          accounts: pages.filter((p) => p.instagram_business_account).map((p) => ({ ig_user_id: p.instagram_business_account!.id, username: p.instagram_business_account!.username ?? null, page_id: p.id, page_name: p.name })),
        };
      },
    },
    publish_image: {
      key: "publish_image",
      name: "Publish photo",
      description: "Publish a JPEG image from a public https URL.",
      input: z.object({ ig_user_id: igUserId, image_url: mediaUrl, caption, alt_text: z.string().max(1_000).optional() }),
      async run(ctx, i) {
        const token = await tokenFor(ctx, i.ig_user_id);
        await assertQuota(ctx, i.ig_user_id, token);
        const c = await graph<{ id: string }>(ctx, "POST", `${i.ig_user_id}/media`, { image_url: i.image_url, caption: i.caption, alt_text: i.alt_text }, token);
        return publish(ctx, i.ig_user_id, c.id, token);
      },
    },
    publish_carousel: {
      key: "publish_carousel",
      name: "Publish carousel",
      description: "Publish 2–20 JPEG images (public https URLs) as one carousel post.",
      input: z.object({ ig_user_id: igUserId, image_urls: z.array(mediaUrl).min(2).max(20), caption }),
      async run(ctx, i) {
        const token = await tokenFor(ctx, i.ig_user_id);
        await assertQuota(ctx, i.ig_user_id, token);
        const children: string[] = [];
        for (const url of i.image_urls) {
          const c = await graph<{ id: string }>(ctx, "POST", `${i.ig_user_id}/media`, { image_url: url, is_carousel_item: true }, token);
          children.push(c.id);
        }
        for (const id of children) await waitUntilReady(ctx, id, token);
        const carousel = await graph<{ id: string }>(ctx, "POST", `${i.ig_user_id}/media`, { media_type: "CAROUSEL", children: children.join(","), caption: i.caption }, token);
        return { ...(await publish(ctx, i.ig_user_id, carousel.id, token)), items: children.length };
      },
    },
    publish_reel: {
      key: "publish_reel",
      name: "Publish reel",
      description: "Publish a video (MP4, public https URL) as a reel. Processing can take a few minutes.",
      input: z.object({ ig_user_id: igUserId, video_url: mediaUrl, caption, cover_url: mediaUrl.optional() }),
      async run(ctx, i) {
        const token = await tokenFor(ctx, i.ig_user_id);
        await assertQuota(ctx, i.ig_user_id, token);
        const c = await graph<{ id: string }>(ctx, "POST", `${i.ig_user_id}/media`, { media_type: "REELS", video_url: i.video_url, caption: i.caption, cover_url: i.cover_url }, token);
        return publish(ctx, i.ig_user_id, c.id, token);
      },
    },
    get_publishing_limit: {
      key: "get_publishing_limit",
      name: "Get publishing limit",
      description: "Posts published through the API in the last 24 hours and the account's limit.",
      input: z.object({ ig_user_id: igUserId }),
      async run(ctx, i) {
        const token = await tokenFor(ctx, i.ig_user_id);
        const r = await graph<{ data: Array<{ quota_usage?: number; config?: { quota_total?: number; quota_duration?: number } }> }>(ctx, "GET", `${i.ig_user_id}/content_publishing_limit`, { fields: "config,quota_usage" }, token);
        return { used: r.data[0]?.quota_usage ?? 0, limit: r.data[0]?.config?.quota_total ?? null, window_seconds: r.data[0]?.config?.quota_duration ?? null };
      },
    },
  },
  triggers: {},
};
