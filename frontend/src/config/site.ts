const DEFAULT_SITE_URL = "https://telzyra.com";

/** Accept only a full absolute URL; an empty or half-resolved value ("https://") falls back. */
function resolveSiteUrl(value: string | undefined): string {
  if (!value) return DEFAULT_SITE_URL;
  try {
    const url = new URL(value);
    return url.hostname ? url.origin : DEFAULT_SITE_URL;
  } catch {
    return DEFAULT_SITE_URL;
  }
}

export const SITE = {
  name: "Telzyra",
  url: resolveSiteUrl(process.env.NEXT_PUBLIC_SITE_URL),
  /** Telzyra Platform API. When unset, API-backed features report "unavailable". */
  apiUrl: process.env.TELZYRA_API_URL ?? "",
  /** API origin used by the browser (login, register, logout). Inlined at build time. */
  publicApiUrl: process.env.NEXT_PUBLIC_API_URL ?? "",
  contactEmail: "hello@telzyra.com",
  support: {
    /** WhatsApp number in international format, digits only (used in https://wa.me/<number>). */
    whatsapp: "994503066626",
  },
  /** Search engine ownership verification (public codes, rendered as <meta> tags). */
  verification: {
    yandex: "61f69b35dd2d7e48",
  },
} as const;

/** Public, indexable marketing pages (unlocalized paths). Used by the sitemap. */
export const PUBLIC_PAGES = [
  "/",
  "/features",
  "/integrations",
  "/pricing",
  "/docs",
  "/privacy",
  "/terms",
] as const;

/** Header navigation: keys map to common.nav.* messages. Text never lives here. */
export const MAIN_NAV = [
  { key: "product", href: "/features" },
  { key: "integrations", href: "/integrations" },
  { key: "useCases", href: "/#use-cases" },
  { key: "pricing", href: "/pricing" },
  { key: "resources", href: "/docs" },
] as const;
