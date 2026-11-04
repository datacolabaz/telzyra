import { ACTIVE_LOCALES, DEFAULT_LOCALE, LOCALES, type Locale } from "./config";

/**
 * Build a public href for a locale. English (default) is unprefixed.
 *   localizedPath("en", "/pricing") -> "/pricing"
 *   localizedPath("az", "/pricing") -> "/az/pricing"
 *   localizedPath("tr", "/")        -> "/tr"
 */
export function localizedPath(locale: Locale, path: string = "/"): string {
  const clean = path === "" ? "/" : path.startsWith("/") ? path : `/${path}`;
  if (locale === DEFAULT_LOCALE) return clean;
  return clean === "/" ? `/${locale}` : `/${locale}${clean}`;
}

/** Remove any active-locale prefix from a pathname. */
export function stripLocale(pathname: string): string {
  const segments = pathname.split("/");
  if ((ACTIVE_LOCALES as string[]).includes(segments[1] ?? "")) {
    const rest = "/" + segments.slice(2).join("/");
    return rest === "/" ? "/" : rest.replace(/\/$/, "");
  }
  return pathname || "/";
}

/** hreflang alternates for a path: every active locale + x-default (English). */
export function languageAlternates(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const l of ACTIVE_LOCALES) out[LOCALES[l].hreflang] = localizedPath(l, path);
  out["x-default"] = localizedPath(DEFAULT_LOCALE, path);
  return out;
}
