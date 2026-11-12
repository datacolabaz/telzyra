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
