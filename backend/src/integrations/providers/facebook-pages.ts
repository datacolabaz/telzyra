import { z } from "zod";
import { ConnectorError } from "../core/errors.js";
import type { ConnectorDefinition } from "../core/types.js";
import { graph, managedPages, metaMapError, pageToken, publicPage } from "./meta.js";

/**
 * Facebook Pages — publish to Pages the user manages (Graph API Pages API).
 * Personal profiles cannot be posted to through any Meta API.
 * Permissions: pages_show_list, pages_read_engagement, pages_manage_posts (Advanced Access via App
 * Review for users outside the Meta app's roles). The user needs the CREATE_CONTENT task on the Page.
 * Posts are not idempotent at Meta: a POST is never retried automatically after a 5xx/timeout.
 */
const pageId = z.string().regex(/^\d{5,25}$/, "Facebook Page id");

/** Scheduled posts must be 10 minutes to 30 days in the future (Meta rule). */
const scheduledAt = z
  .string()
  .datetime({ offset: true })
  .refine((v) => {
    const t = Date.parse(v) - Date.now();
    return t >= 10 * 60_000 && t <= 30 * 86_400_000;
  }, "Must be between 10 minutes and 30 days in the future")
  .optional();
const unix = (iso?: string) => (iso ? Math.floor(Date.parse(iso) / 1000) : undefined);

export const facebookPages: ConnectorDefinition = {
  id: "facebook-pages",
  name: "Facebook Pages",
  description: "Publish posts and photos to Facebook Pages you manage.",
  category: "social",
  auth: { type: "oauth2", provider: "meta", scopes: ["pages_show_list", "pages_read_engagement", "pages_manage_posts", "business_management"] },
  requiredEnv: ["META_APP_ID", "META_APP_SECRET"],
  rateLimit: { note: "Page rate limits are based on engaged users (Business Use Case). Codes 4/17/32/613 are retried after a pause." },
  mapError: metaMapError("facebook-pages"),

  async test(ctx) {
    const me = await graph<{ id: string; name: string }>(ctx, "GET", "me", { fields: "id,name" });
    return { accountId: me.id, accountName: me.name };
  },

  actions: {
    list_pages: {
      key: "list_pages",
      name: "List Pages",
      description: "Pages the connected account manages (and their linked Instagram accounts).",
      input: z.object({}),
      async run(ctx) {
        return { pages: (await managedPages(ctx)).map(publicPage) };
      },
    },
    create_post: {
      key: "create_post",
      name: "Create post",
      description: "Publish (or schedule) a text or link post on a Page.",
      input: z
        .object({ page_id: pageId, message: z.string().max(63_206).optional(), link: z.string().url().optional(), scheduled_at: scheduledAt })
        .refine((i) => i.message || i.link, "message or link is required"),
      async run(ctx, i) {
        const token = await pageToken(ctx, i.page_id);
        const r = await graph<{ id: string }>(ctx, "POST", `${i.page_id}/feed`, { message: i.message, link: i.link, ...(i.scheduled_at ? { published: false, scheduled_publish_time: unix(i.scheduled_at) } : {}) }, token);
        return { post_id: r.id, scheduled: !!i.scheduled_at, url: `https://www.facebook.com/${r.id}` };
      },
    },
    publish_photo: {
      key: "publish_photo",
      name: "Publish photo",
      description: "Publish (or schedule) a photo from a public URL on a Page.",
      input: z.object({ page_id: pageId, image_url: z.string().url(), caption: z.string().max(63_206).optional(), scheduled_at: scheduledAt }),
      async run(ctx, i) {
        const token = await pageToken(ctx, i.page_id);
        const r = await graph<{ id: string; post_id?: string }>(ctx, "POST", `${i.page_id}/photos`, { url: i.image_url, caption: i.caption, ...(i.scheduled_at ? { published: false, scheduled_publish_time: unix(i.scheduled_at) } : {}) }, token);
        return { photo_id: r.id, post_id: r.post_id ?? null, scheduled: !!i.scheduled_at };
      },
    },
    delete_post: {
      key: "delete_post",
      name: "Delete post",
      description: "Delete a Page post.",
      input: z.object({ page_id: pageId, post_id: z.string().regex(/^\d+_\d+$/, "Page post id (pageid_postid)") }),
      async run(ctx, i) {
        if (!i.post_id.startsWith(`${i.page_id}_`)) throw new ConnectorError("VALIDATION", "post_id does not belong to page_id");
        const token = await pageToken(ctx, i.page_id);
        const r = await graph<{ success: boolean }>(ctx, "DELETE", i.post_id, {}, token);
        return { deleted: r.success };
      },
    },
  },
  triggers: {},
};
