"use client";

import { useEffect, useId, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { Check, ChevronDown, Globe } from "lucide-react";
import type { Locale } from "@/i18n/config";
import { rememberLocale } from "@/i18n/client";
import { localizedPath, stripLocale } from "@/i18n/routing";

export interface LanguageOption {
  code: Locale;
  nativeName: string;
}

/**
 * Language dropdown. Options follow the locale registry order (AZ, RU, TR, EN).
 * Choosing one writes the TELZYRA_LOCALE cookie, so the choice is remembered, then opens
 * the same page in that language. Options are real <a href> links that crawlers can follow.
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
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  const basePath = stripLocale(usePathname() ?? "/");
  const currentOption = options.find((o) => o.code === current);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        buttonRef.current?.focus();
      }
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const items = Array.from(ref.current?.querySelectorAll<HTMLAnchorElement>("a") ?? []);
        const index = items.indexOf(document.activeElement as HTMLAnchorElement);
        const next = e.key === "ArrowDown" ? index + 1 : index - 1;
        items[(next + items.length) % items.length]?.focus();
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        ref={buttonRef}
        type="button"
        aria-haspopup="true"
        aria-expanded={open}
        aria-controls={menuId}
        aria-label={`${label}: ${currentOption?.nativeName ?? current}`}
        onClick={() => setOpen((v) => !v)}
        className="inline-flex h-9 items-center gap-1.5 rounded-lg px-2.5 text-sm font-medium text-ink-700 transition-colors hover:bg-ink-50 hover:text-ink-950"
      >
        <Globe className="size-4 text-ink-400" aria-hidden />
        <span className="uppercase tracking-wide">{current}</span>
        <ChevronDown
          className={`size-3.5 text-ink-400 transition-transform ${open ? "rotate-180" : ""}`}
          aria-hidden
        />
      </button>

      {open && (
        <ul
          id={menuId}
          className="absolute right-0 z-50 mt-1.5 w-48 rounded-xl border border-ink-100 bg-white p-1 shadow-[var(--shadow-float)]"
        >
          {options.map((o) => {
            const active = o.code === current;
            return (
              <li key={o.code}>
                <a
                  href={localizedPath(o.code, basePath)}
                  hrefLang={o.code}
                  lang={o.code}
                  aria-current={active ? "true" : undefined}
                  onClick={() => rememberLocale(o.code)}
                  className={`flex items-center gap-3 rounded-lg px-3 py-2 text-sm outline-none hover:bg-ink-50 focus-visible:bg-ink-50 ${
                    active ? "text-ink-950" : "text-ink-700"
                  }`}
                >
                  <span className="w-6 text-xs font-semibold uppercase tracking-wide text-ink-400">{o.code}</span>
                  <span className="flex-1">{o.nativeName}</span>
                  {active && <Check className="size-4 text-brand-600" aria-hidden />}
                </a>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
