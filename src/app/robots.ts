import type { MetadataRoute } from "next";
import { SITE } from "@/config/site";
import { ACTIVE_LOCALES, DEFAULT_LOCALE } from "@/i18n/config";

const PRIVATE = ["/dashboard", "/login", "/register", "/reset-password", "/verify-email", "/onboarding"];

export default function robots(): MetadataRoute.Robots {
  const disallow = PRIVATE.flatMap((p) => [
    p,
    ...ACTIVE_LOCALES.filter((l) => l !== DEFAULT_LOCALE).map((l) => `/${l}${p}`),
  ]);
  return {
    rules: [{ userAgent: "*", allow: "/", disallow }],
    sitemap: new URL("/sitemap.xml", SITE.url).toString(),
  };
}
