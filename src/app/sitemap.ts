import type { MetadataRoute } from "next";
import { ACTIVE_LOCALES } from "@/i18n/config";
import { languageAlternates, localizedPath } from "@/i18n/routing";
import { PUBLIC_PAGES, SITE } from "@/config/site";

/** One entry per page per active locale, each listing all language alternates. */
export default function sitemap(): MetadataRoute.Sitemap {
  const abs = (p: string) => new URL(p, SITE.url).toString();
  return PUBLIC_PAGES.flatMap((page) => {
    const languages = Object.fromEntries(
      Object.entries(languageAlternates(page)).map(([lang, href]) => [lang, abs(href)]),
    );
    return ACTIVE_LOCALES.map((locale) => ({
      url: abs(localizedPath(locale, page)),
      changeFrequency: "weekly" as const,
      priority: page === "/" ? 1 : 0.8,
      alternates: { languages },
    }));
  });
}
