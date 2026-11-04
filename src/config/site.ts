export const SITE = {
  name: "Telzyra",
  url: process.env.NEXT_PUBLIC_SITE_URL ?? "https://telzyra.com",
  /** Telzyra Platform API. When unset, API-backed features report "unavailable". */
  apiUrl: process.env.TELZYRA_API_URL ?? "",
  contactEmail: "hello@telzyra.com",
} as const;

/** Public, indexable marketing pages (unlocalized paths). Used by the sitemap. */
export const PUBLIC_PAGES = ["/", "/features", "/integrations", "/pricing"] as const;

/** Header navigation: keys map to common.nav.* messages. Text never lives here. */
export const MAIN_NAV = [
  { key: "product", href: "/features" },
  { key: "integrations", href: "/integrations" },
  { key: "useCases", href: "/#use-cases" },
  { key: "pricing", href: "/pricing" },
  { key: "resources", href: "/#faq" },
] as const;
