import "@fontsource-variable/inter";
import "../globals.css";
import type { Metadata, Viewport } from "next";
import { ACTIVE_LOCALES, LOCALES } from "@/i18n/config";
import { getLocale, getTranslations } from "@/i18n/server";
import { SITE } from "@/config/site";

export function generateStaticParams() {
  return ACTIVE_LOCALES.map((locale) => ({ locale }));
}

// Only active locales are routable: getLocale() calls notFound() for planned ones (e.g. "ru").

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("seo");
  return {
    metadataBase: new URL(SITE.url),
    title: { default: SITE.name, template: t("titleTemplate") },
    applicationName: SITE.name,
    verification: { yandex: SITE.verification.yandex },
  };
}

export const viewport: Viewport = { themeColor: "#0B0D2A" };

export default async function RootLayout({ children }: LayoutProps<"/[locale]">) {
  const locale = await getLocale();
  const c = await getTranslations("common");
  return (
    <html lang={LOCALES[locale].hreflang} dir={LOCALES[locale].dir} data-scroll-behavior="smooth">
      <body className="min-h-dvh">
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-lg focus:bg-white focus:px-4 focus:py-2 focus:text-sm focus:shadow-[var(--shadow-float)]"
        >
          {c("labels.skipToContent")}
        </a>
        {children}
      </body>
    </html>
  );
}
