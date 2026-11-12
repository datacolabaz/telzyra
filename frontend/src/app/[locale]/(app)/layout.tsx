import Link from "next/link";
import { Logo } from "@/components/brand/Logo";
import { LanguageSwitcher } from "@/components/i18n/LanguageSwitcher";
import { Container } from "@/components/ui/primitives";
import { ACTIVE_LOCALES, LOCALES } from "@/i18n/config";
import { localizedPath } from "@/i18n/routing";
import { getLocale, getTranslations } from "@/i18n/server";

/** Authenticated app shell. Pages under it are private (noindex) and rendered per request. */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const locale = await getLocale();
  const c = await getTranslations("common");
  const languages = ACTIVE_LOCALES.map((code) => ({ code, nativeName: LOCALES[code].nativeName }));
  return (
    <div className="min-h-dvh bg-ink-50/60">
      <header className="border-b border-ink-100 bg-white">
        <Container className="flex h-16 items-center justify-between">
          <Link href={localizedPath(locale, "/dashboard")} aria-label="Telzyra">
            <Logo />
          </Link>
          <LanguageSwitcher current={locale} options={languages} label={c("language.label")} />
        </Container>
      </header>
      <main id="main">{children}</main>
    </div>
  );
}
