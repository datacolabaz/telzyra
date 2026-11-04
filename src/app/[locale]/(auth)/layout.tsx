import Link from "next/link";
import { Logo } from "@/components/brand/Logo";
import { LanguageSwitcher } from "@/components/i18n/LanguageSwitcher";
import { ACTIVE_LOCALES, LOCALES } from "@/i18n/config";
import { localizedPath } from "@/i18n/routing";
import { getLocale, getTranslations } from "@/i18n/server";

export default async function AuthLayout({ children }: { children: React.ReactNode }) {
  const locale = await getLocale();
  const c = await getTranslations("common");
  const languages = ACTIVE_LOCALES.map((code) => ({ code, nativeName: LOCALES[code].nativeName }));

  return (
    <div className="flex min-h-dvh flex-col bg-ink-50/60">
      <header className="flex h-16 items-center justify-between px-5 sm:px-8">
        <Link href={localizedPath(locale, "/")} aria-label="Telzyra">
          <Logo />
        </Link>
        <LanguageSwitcher current={locale} options={languages} label={c("language.label")} />
      </header>
      <main id="main" className="flex flex-1 items-start justify-center px-5 pb-16 pt-8 sm:pt-16">
        <div className="w-full max-w-sm rounded-2xl border border-ink-100 bg-white p-7 shadow-[var(--shadow-float)]">
          {children}
        </div>
      </main>
    </div>
  );
}
