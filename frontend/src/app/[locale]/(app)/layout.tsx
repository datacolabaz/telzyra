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
  const a = await getTranslations("app");
  const nav = [
    { href: "/dashboard", label: a("nav.dashboard") },
    { href: "/dashboard/integrations", label: a("nav.integrations") },
    { href: "/dashboard/workflows", label: a("nav.workflows") },
  ];
  const languages = ACTIVE_LOCALES.map((code) => ({ code, nativeName: LOCALES[code].nativeName }));
  return (
    <div className="min-h-dvh bg-ink-50/60">
      <header className="border-b border-ink-100 bg-white">
        <Container className="flex h-16 items-center justify-between">
          <div className="flex min-w-0 items-center gap-3 sm:gap-6">
            <Link href={localizedPath(locale, "/dashboard")} aria-label="Telzyra">
              <Logo />
            </Link>
            <nav aria-label="App" className="flex items-center gap-0.5 sm:gap-1">
              {nav.map((n) => (
                <Link key={n.href} href={localizedPath(locale, n.href)} className="rounded-md px-1.5 py-1.5 text-xs font-medium text-ink-600 hover:bg-ink-50 hover:text-ink-950 sm:px-2.5 sm:text-sm">
                  {n.label}
                </Link>
              ))}
            </nav>
          </div>
          <LanguageSwitcher current={locale} options={languages} label={c("language.label")} />
        </Container>
      </header>
      <main id="main">{children}</main>
    </div>
  );
}
