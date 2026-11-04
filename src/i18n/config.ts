import type { Currency } from "@/config/currency";

/**
 * Locale registry — the single source of truth for languages.
 *
 * Entry order is the display order of the language switcher (AZ | RU | TR | EN).
 * The default (unprefixed) locale is set separately by DEFAULT_LOCALE.
 *
 * To add a language:
 *   1. Add an entry here with status "planned".
 *   2. Create src/i18n/messages/<code>/ with the same namespaces as "en".
 *   3. Run `npm run i18n:check`, then switch status to "active".
 * No component changes are required.
 */
export const LOCALES = {
  az: {
    status: "active",
    nativeName: "Azərbaycanca",
    englishName: "Azerbaijani",
    hreflang: "az",
    ogLocale: "az_AZ",
    intl: "az-AZ",
    dir: "ltr",
    defaultCurrency: "AZN",
  },
  ru: {
    status: "active",
    nativeName: "Русский",
    englishName: "Russian",
    hreflang: "ru",
    ogLocale: "ru_RU",
    intl: "ru-RU",
    dir: "ltr",
    defaultCurrency: "AZN",
  },
  tr: {
    status: "active",
    nativeName: "Türkçe",
    englishName: "Turkish",
    hreflang: "tr",
    ogLocale: "tr_TR",
    intl: "tr-TR",
    dir: "ltr",
    defaultCurrency: "TRY",
  },
  en: {
    status: "active",
    nativeName: "English",
    englishName: "English",
    hreflang: "en",
    ogLocale: "en_US",
    intl: "en-US",
    dir: "ltr",
    defaultCurrency: "USD",
  },
} as const satisfies Record<string, LocaleDefinition>;

export interface LocaleDefinition {
  status: "active" | "planned";
  nativeName: string;
  englishName: string;
  hreflang: string;
  ogLocale: string;
  intl: string;
  dir: "ltr" | "rtl";
  /** Currency shown on pricing until the visitor picks another one. */
  defaultCurrency: Currency;
}

export type AnyLocale = keyof typeof LOCALES;

type ActiveKeys<T> = {
  [K in keyof T]: T[K] extends { status: "active" } ? K : never;
}[keyof T];

/** Locales that are routable and published. */
export type Locale = ActiveKeys<typeof LOCALES>;

export const DEFAULT_LOCALE: Locale = "en";

export const ACTIVE_LOCALES = (Object.keys(LOCALES) as AnyLocale[]).filter(
  (l) => LOCALES[l].status === "active",
) as Locale[];

export const ALL_LOCALES = Object.keys(LOCALES) as AnyLocale[];

/** Cookie storing the user's explicit language choice. */
export const LOCALE_COOKIE = "TELZYRA_LOCALE";
export const LOCALE_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

export function isActiveLocale(value: string | undefined | null): value is Locale {
  return !!value && (ACTIVE_LOCALES as string[]).includes(value);
}
