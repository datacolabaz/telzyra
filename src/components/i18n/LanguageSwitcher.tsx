"use client";

import { Fragment } from "react";
import { usePathname } from "next/navigation";
import type { Locale } from "@/i18n/config";
import { rememberLocale } from "@/i18n/client";
import { localizedPath, stripLocale } from "@/i18n/routing";

export interface LanguageOption {
  code: Locale;
  nativeName: string;
}

/**
 * Inline language switcher: AZ | RU | TR | EN (order comes from the locale registry).
 * Clicking writes the TELZYRA_LOCALE cookie so the choice is remembered, then opens the
 * same page in that language. Links are real <a href>, so crawlers follow every version.
 */
export function LanguageSwitcher({
  current,
  options,
  label,
}: {
  current: Locale;
  options: LanguageOption[];
  label: string;
}) {
  const pathname = usePathname() ?? "/";
  const basePath = stripLocale(pathname);

  return (
    <nav aria-label={label}>
      <ul className="flex items-center text-[13px] font-medium">
        {options.map((o, i) => {
          const active = o.code === current;
          return (
            <Fragment key={o.code}>
              {i > 0 && (
                <li aria-hidden className="select-none px-0.5 text-ink-200">
                  |
                </li>
              )}
              <li>
                <a
                  href={localizedPath(o.code, basePath)}
                  hrefLang={o.code}
                  lang={o.code}
                  title={o.nativeName}
                  aria-label={o.nativeName}
                  aria-current={active ? "true" : undefined}
                  onClick={() => rememberLocale(o.code)}
                  className={`inline-flex h-8 items-center rounded-md px-1.5 uppercase tracking-wide transition-colors ${
                    active ? "text-ink-950" : "text-ink-400 hover:text-ink-950"
                  }`}
                >
                  {o.code}
                </a>
              </li>
            </Fragment>
          );
        })}
      </ul>
    </nav>
  );
}
