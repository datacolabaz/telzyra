import Link from "next/link";
import { Logo } from "@/components/brand/Logo";
import { ButtonLink, Container } from "@/components/ui/primitives";
import { LanguageSwitcher } from "@/components/i18n/LanguageSwitcher";
import { MobileNav } from "./MobileNav";
import { ACTIVE_LOCALES, LOCALES } from "@/i18n/config";
import { localizedPath } from "@/i18n/routing";
import { getLocale, getTranslations } from "@/i18n/server";
import { MAIN_NAV } from "@/config/site";

export async function Header() {
  const locale = await getLocale();
  const t = await getTranslations("common");
  const href = (p: string) => localizedPath(locale, p);
  const languages = ACTIVE_LOCALES.map((code) => ({ code, nativeName: LOCALES[code].nativeName }));
  const nav = MAIN_NAV.map((item) => ({ href: href(item.href), label: t(`nav.${item.key}`) }));

  return (
    <header className="sticky top-0 z-40 border-b border-ink-100/80 bg-white/85 backdrop-blur-md">
      <Container className="flex h-16 items-center gap-6">
        <Link href={href("/")} aria-label="Telzyra" className="shrink-0">
          <Logo />
        </Link>

        <nav aria-label={t("nav.mainLabel")} className="hidden lg:block">
          <ul className="flex items-center gap-1">
            {nav.map((item) => (
              <li key={item.href}>
                <Link
                  href={item.href}
                  className="rounded-lg px-3 py-2 text-sm font-medium text-ink-500 hover:text-ink-950"
                >
                  {item.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>

        <div className="ml-auto flex items-center gap-1.5">
          <LanguageSwitcher current={locale} options={languages} label={t("language.label")} />
          <div className="hidden items-center gap-1.5 sm:flex">
            <ButtonLink href={href("/login")} variant="ghost">
              {t("cta.login")}
            </ButtonLink>
            <ButtonLink href={href("/register")}>{t("cta.startFree")}</ButtonLink>
          </div>
          <MobileNav
            items={nav}
            login={{ href: href("/login"), label: t("cta.login") }}
            start={{ href: href("/register"), label: t("cta.startFree") }}
            openLabel={t("nav.openMenu")}
            closeLabel={t("nav.closeMenu")}
          />
        </div>
      </Container>
    </header>
  );
}
