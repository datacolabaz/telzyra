import { cache } from "react";
import { notFound } from "next/navigation";
import { locale as rootLocale } from "next/root-params";
import { LOCALES, isActiveLocale, type Locale } from "./config";
import { loadNamespace, type Messages, type Namespace } from "./messages";
import { createTranslator, type Translator } from "./translator";

/** Current locale from the [locale] root segment (Server Components only). */
export const getLocale = cache(async (): Promise<Locale> => {
  const value = await rootLocale();
  if (!isActiveLocale(value)) notFound();
  return value;
});

const getNamespace = cache(async (locale: Locale, ns: Namespace) => loadNamespace(locale, ns));

export async function getTranslations<N extends Namespace>(
  ns: N,
  locale?: Locale,
): Promise<Translator<Messages[N]>> {
  const l = locale ?? (await getLocale());
  const messages = (await getNamespace(l, ns)) as Messages[N];
  return createTranslator<Messages[N]>(messages, ns);
}

/** Locale-aware formatters. Currency is USD for all locales. */
export async function getFormatters(locale?: Locale) {
  const l = locale ?? (await getLocale());
  const intl = LOCALES[l].intl;
  return {
    currency: (amount: number, currency = "USD") =>
      new Intl.NumberFormat(intl, {
        style: "currency",
        currency,
        maximumFractionDigits: amount % 1 === 0 ? 0 : 2,
      }).format(amount),
    number: (n: number) => new Intl.NumberFormat(intl).format(n),
    date: (d: Date, opts?: Intl.DateTimeFormatOptions) =>
      new Intl.DateTimeFormat(intl, opts ?? { dateStyle: "medium" }).format(d),
  };
}
