import type { AnyLocale } from "./config";
import { DEFAULT_LOCALE } from "./config";

import type enCommon from "./messages/en/common.json";
import type enSeo from "./messages/en/seo.json";
import type enHome from "./messages/en/home.json";
import type enPricing from "./messages/en/pricing.json";
import type enFeatures from "./messages/en/features.json";
import type enIntegrations from "./messages/en/integrations.json";
import type enAuth from "./messages/en/auth.json";
import type enValidation from "./messages/en/validation.json";
import type enNodes from "./messages/en/nodes.json";
import type enLegal from "./messages/en/legal.json";
import type enDocs from "./messages/en/docs.json";
import type enApp from "./messages/en/app.json";

/** English is the reference shape for every locale. */
export interface Messages {
  common: typeof enCommon;
  seo: typeof enSeo;
  home: typeof enHome;
  pricing: typeof enPricing;
  features: typeof enFeatures;
  integrations: typeof enIntegrations;
  auth: typeof enAuth;
  validation: typeof enValidation;
  nodes: typeof enNodes;
  legal: typeof enLegal;
  docs: typeof enDocs;
  app: typeof enApp;
}

export type Namespace = keyof Messages;

export const NAMESPACES: Namespace[] = [
  "common",
  "seo",
  "home",
  "pricing",
  "features",
  "integrations",
  "auth",
  "validation",
  "nodes",
  "legal",
  "docs",
  "app",
];

async function importNamespace(locale: AnyLocale, ns: Namespace): Promise<unknown> {
  try {
    const mod = await import(`./messages/${locale}/${ns}.json`);
    return mod.default;
  } catch {
    return undefined;
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Deep-merge `override` onto `base` so missing keys fall back to English. */
function withFallback<T>(base: T, override: unknown): T {
  if (!isObject(base) || !isObject(override)) {
    return (override ?? base) as T;
  }
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(override)) {
    out[k] = k in base ? withFallback((base as Record<string, unknown>)[k], v) : v;
  }
  return out as T;
}

export async function loadNamespace<N extends Namespace>(
  locale: AnyLocale,
  ns: N,
): Promise<Messages[N]> {
  const base = (await importNamespace(DEFAULT_LOCALE, ns)) as Messages[N];
  if (locale === DEFAULT_LOCALE) return base;
  return withFallback(base, await importNamespace(locale, ns));
}
