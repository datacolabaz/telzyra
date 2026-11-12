import type { Metadata } from "next";
import { ACTIVE_LOCALES, LOCALES, type Locale } from "./config";
import { languageAlternates, localizedPath } from "./routing";
import { getLocale, getTranslations } from "./server";
import { SITE } from "@/config/site";

type SeoPage =
  | "home"
  | "pricing"
  | "features"
  | "integrations"
  | "docs"
  | "privacy"
  | "terms"
  | "dashboard"
  | "login"
  | "register";

/**
 * Per-locale metadata: title, description, canonical, hreflang alternates, Open Graph.
 * Pages pass their unlocalized path, e.g. "/pricing".
 */
export async function buildMetadata(
  page: SeoPage,
  path: string,
  opts: { index?: boolean } = {},
): Promise<Metadata> {
  const locale: Locale = await getLocale();
  const t = await getTranslations("seo", locale);
  const title = t(`${page}.title`);
  const description = t(`${page}.description`);
  const canonical = localizedPath(locale, path);
  const index = opts.index ?? true;

  return {
    metadataBase: new URL(SITE.url),
    title: page === "home" ? { absolute: title } : title,
    description,
    alternates: index
      ? { canonical, languages: languageAlternates(path) }
      : { canonical },
    robots: index ? { index: true, follow: true } : { index: false, follow: false },
    openGraph: {
      type: "website",
      siteName: SITE.name,
      url: canonical,
      title,
      description,
      locale: LOCALES[locale].ogLocale,
      alternateLocale: ACTIVE_LOCALES.filter((l) => l !== locale).map(
        (l) => LOCALES[l].ogLocale,
      ),
    },
    twitter: { card: "summary_large_image", title, description },
  };
}
