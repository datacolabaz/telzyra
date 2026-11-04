/**
 * Display currencies. Order here is the order of the pricing currency selector.
 *
 * Prices are NOT converted at runtime from a live exchange rate. Each plan has a fixed
 * price point per currency (see config/plans.ts), so customers see stable, rounded
 * prices and billing matches what was shown.
 */
export const CURRENCIES = {
  AZN: { symbol: "₼", fractionDigits: 2 },
  USD: { symbol: "$", fractionDigits: 2 },
  TRY: { symbol: "₺", fractionDigits: 0 },
  RUB: { symbol: "₽", fractionDigits: 0 },
} as const;

export type Currency = keyof typeof CURRENCIES;

export const CURRENCY_ORDER = Object.keys(CURRENCIES) as Currency[];

/** Cookie storing the visitor's explicit currency choice. */
export const CURRENCY_COOKIE = "TELZYRA_CURRENCY";

export function isCurrency(value: string | null | undefined): value is Currency {
  return !!value && value in CURRENCIES;
}

/** Locale-aware price formatting with the plain symbol (₼, $, ₺, ₽), never "US$". */
export function formatPrice(amount: number, currency: Currency, intlLocale: string): string {
  const whole = amount % 1 === 0;
  // Browser ICU data for az-AZ is incomplete (prints "₼ 1,549"). Azerbaijani convention
  // per CLDR is "1.549,50 ₼": dot grouping, comma decimal, symbol after the number.
  if (intlLocale.startsWith("az")) {
    const digits = whole ? 0 : CURRENCIES[currency].fractionDigits;
    const number = new Intl.NumberFormat("tr-TR", {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    }).format(amount);
    return `${number} ${CURRENCIES[currency].symbol}`;
  }
  return new Intl.NumberFormat(intlLocale, {
    style: "currency",
    currency,
    currencyDisplay: "narrowSymbol",
    minimumFractionDigits: whole ? 0 : CURRENCIES[currency].fractionDigits,
    maximumFractionDigits: whole ? 0 : CURRENCIES[currency].fractionDigits,
  }).format(amount);
}
