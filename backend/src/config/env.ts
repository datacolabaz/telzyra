import { z } from "zod";

/**
 * All configuration comes from environment variables, validated once at startup.
 * Secrets are never read anywhere else, never logged and never given defaults in production.
 */
const hex32 = z
  .string()
  .regex(/^[0-9a-fA-F]{64}$/, "must be 64 hex characters (32 bytes)");

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(4000),
  HOST: z.string().default("::"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),

  DATABASE_URL: z.string().url(),

  /** Public origin of the web app, e.g. https://telzyra.com */
  APP_URL: z.string().url().default("http://localhost:3000"),
  /** Browser origins allowed to call the API (CORS + CSRF Origin check). */
  CORS_ORIGINS: z
    .string()
    .default("http://localhost:3000")
    .transform((v) => v.split(",").map((o) => o.trim()).filter(Boolean)),
  /** Cookie domain shared by app and API, e.g. ".telzyra.com". Empty = host-only. */
  COOKIE_DOMAIN: z.string().optional(),

  /** AES-256-GCM key for stored credentials (current version). */
  CREDENTIALS_KEY: hex32,
  CREDENTIALS_KEY_VERSION: z.coerce.number().int().positive().default(1),
  /** Older keys kept only to decrypt during rotation: "1:<hex>,2:<hex>". */
  CREDENTIALS_PREVIOUS_KEYS: z.string().optional(),

  /** Public origin of this API (OAuth redirect URIs, webhook URLs), e.g. https://api.telzyra.com */
  PUBLIC_API_URL: z.string().url().default("http://localhost:4000"),
  /**
   * Public HTTPS origin providers deliver webhooks to. Defaults to PUBLIC_API_URL. Set it separately
   * when the API itself is local (OAuth redirects stay on localhost) but webhooks arrive through an
   * HTTPS tunnel, e.g. https://xyz.trycloudflare.com.
   */
  PUBLIC_WEBHOOK_URL: z.string().url().optional(),
  /** Run queue workers in this process (webhooks, workflow executions, polling). */
  RUN_WORKERS: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),

  // ── Provider apps (all optional: a provider without credentials shows as "not configured") ──
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  SLACK_CLIENT_ID: z.string().optional(),
  SLACK_CLIENT_SECRET: z.string().optional(),
  SLACK_SIGNING_SECRET: z.string().optional(),
  NOTION_CLIENT_ID: z.string().optional(),
  NOTION_CLIENT_SECRET: z.string().optional(),
  /** Token Notion sends once to the webhook endpoint; used to verify X-Notion-Signature. */
  NOTION_WEBHOOK_VERIFICATION_TOKEN: z.string().optional(),
  HUBSPOT_CLIENT_ID: z.string().optional(),
  HUBSPOT_CLIENT_SECRET: z.string().optional(),
  HUBSPOT_APP_ID: z.string().optional(),
  SHOPIFY_CLIENT_ID: z.string().optional(),
  SHOPIFY_CLIENT_SECRET: z.string().optional(),
  /** Meta (Facebook Pages, Instagram) — Meta for Developers app (Facebook Login for Business). */
  META_APP_ID: z.string().optional(),
  META_APP_SECRET: z.string().optional(),
  /**
   * Gmail reading (search/read actions + "new email" trigger) needs the restricted gmail.readonly
   * scope, which requires Google verification + a yearly paid CASA assessment for public apps.
   * Off by default: Gmail connects with gmail.send only (sensitive scope, no CASA).
   */
  GMAIL_READ_ENABLED: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  META_GRAPH_VERSION: z.string().regex(/^v\d+\.\d+$/).default("v27.0"),
  SHOPIFY_API_VERSION: z.string().default("2026-10"),

  /**
   * Telegram triggers: "webhook" (needs a public HTTPS webhook URL), "polling" (getUpdates; works
   * on localhost) or "auto" = webhook when the webhook URL is public HTTPS, otherwise polling.
   */
  TELEGRAM_TRIGGER_MODE: z.enum(["auto", "webhook", "polling"]).default("auto"),
  /** Default minutes between polls for polling triggers. */
  POLL_INTERVAL_MINUTES: z.coerce.number().int().min(1).max(60).default(5),

  /** Retention (days) for workflow run history and raw webhook payloads. 0 = keep forever. Audit logs are never purged. */
  EXECUTION_RETENTION_DAYS: z.coerce.number().int().min(0).max(3650).default(30),
  WEBHOOK_EVENT_RETENTION_DAYS: z.coerce.number().int().min(0).max(3650).default(30),

  SESSION_TTL_DAYS: z.coerce.number().int().positive().default(30),
  /** Number of reverse proxies in front of the app (Railway edge = 1). */
  TRUST_PROXY: z.coerce.number().int().min(0).default(1),
});

export type Env = z.infer<typeof schema>;

function load(): Env {
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    // Only variable names and messages are printed, never values.
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return parsed.data;
}

export const env = load();
export const isProduction = env.NODE_ENV === "production";

/** Origin providers deliver webhooks to (PUBLIC_WEBHOOK_URL, else PUBLIC_API_URL), without trailing slash. */
export const webhookBaseUrl = (e: Pick<Env, "PUBLIC_API_URL" | "PUBLIC_WEBHOOK_URL"> = env) => (e.PUBLIC_WEBHOOK_URL ?? e.PUBLIC_API_URL).replace(/\/+$/, "");
