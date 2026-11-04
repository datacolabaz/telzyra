"use client";

import { useEffect, useId, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { Check, ChevronDown, Languages } from "lucide-react";
import type { Locale } from "@/i18n/config";
import { rememberLocale } from "@/i18n/client";
import { localizedPath, stripLocale } from "@/i18n/routing";

export interface LanguageOption {
  code: Locale;
  nativeName: string;
}

/**
 * Explicit language choice. Writes the TELZYRA_LOCALE cookie so the choice is
 * remembered, then navigates to the same page in the chosen language.
 * Links are real <a href> elements, so crawlers can follow every language version.
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
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const pathname = usePathname() ?? "/";
  const basePath = stripLocale(pathname);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);


  const currentOption = options.find((o) => o.code === current);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-haspopup="true"
        aria-expanded={open}
        aria-controls={menuId}
        aria-label={`${label}: ${currentOption?.nativeName}`}
        onClick={() => setOpen((v) => !v)}
        className="inline-flex h-9 items-center gap-1.5 rounded-lg px-2.5 text-sm font-medium text-ink-700 hover:bg-ink-50 hover:text-ink-950"
      >
        <Languages className="size-4" aria-hidden />
        <span className="uppercase">{current}</span>
        <ChevronDown className="size-3.5 text-ink-400" aria-hidden />
      </button>
      {open && (
        <ul
          id={menuId}
          className="absolute right-0 z-50 mt-1.5 w-44 rounded-xl border border-ink-100 bg-white p-1 shadow-[var(--shadow-float)]"
        >
          {options.map((o) => (
            <li key={o.code}>
              <a
                href={localizedPath(o.code, basePath)}
                hrefLang={o.code}
                lang={o.code}
                aria-current={o.code === current ? "true" : undefined}
                onClick={() => rememberLocale(o.code)}
                className="flex items-center justify-between rounded-lg px-3 py-2 text-sm text-ink-800 hover:bg-ink-50"
              >
                {o.nativeName}
                {o.code === current && <Check className="size-4 text-brand-600" aria-hidden />}
              </a>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
