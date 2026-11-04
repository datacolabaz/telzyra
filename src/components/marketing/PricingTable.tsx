"use client";

import Link from "next/link";
import { useState, useSyncExternalStore } from "react";
import { Check } from "lucide-react";
import { buttonClass } from "@/components/ui/primitives";
import { interpolate } from "@/i18n/translator";
import { CURRENCY_COOKIE, formatPrice, isCurrency, type Currency } from "@/config/currency";

type Period = "monthly" | "yearly";

export interface PricingCardData {
  id: string;
  name: string;
  description: string;
  cta: string;
  href: string;
  badge?: string;
  highlighted?: boolean;
  monthlyPrice: Record<Currency, number>;
  items: string[];
}

/* ---- Remembered currency choice (cookie), readable without hydration mismatch ---- */

const CURRENCY_EVENT = "telzyra:currency";

function readCurrencyCookie(): Currency | null {
  const match = document.cookie.match(new RegExp(`(?:^|; )${CURRENCY_COOKIE}=([A-Z]{3})`));
  return match && isCurrency(match[1]) ? match[1] : null;
}

function subscribe(onChange: () => void) {
  window.addEventListener(CURRENCY_EVENT, onChange);
  return () => window.removeEventListener(CURRENCY_EVENT, onChange);
}

function saveCurrency(code: Currency) {
  document.cookie = `${CURRENCY_COOKIE}=${code}; path=/; max-age=${60 * 60 * 24 * 365}; samesite=lax`;
  window.dispatchEvent(new Event(CURRENCY_EVENT));
}

/** All copy arrives pre-localized from the server; this component only holds UI state. */
export function PricingTable({
  plans,
  intlLocale,
  defaultCurrency,
  yearlyMonths,
  currencies,
  labels,
}: {
  plans: PricingCardData[];
  intlLocale: string;
  /** Currency implied by the page language (AZ → ₼, TR → ₺, EN → $, RU → ₼). */
  defaultCurrency: Currency;
  yearlyMonths: number;
  currencies: Array<{ code: Currency; symbol: string; name: string }>;
  labels: {
    monthly: string;
    yearly: string;
    yearlyBadge: string;
    toggleLabel: string;
    currency: string;
    perMonth: string;
    free: string;
    billedYearly: string;
  };
}) {
  const [period, setPeriod] = useState<Period>("monthly");
  const saved = useSyncExternalStore(subscribe, readCurrencyCookie, () => null);
  const currency = saved ?? defaultCurrency;

  const segment = (active: boolean) =>
    `inline-flex h-9 items-center gap-1.5 rounded-lg px-3.5 text-sm font-medium transition-colors ${
      active ? "bg-white text-ink-950 shadow-[var(--shadow-card)]" : "text-ink-500 hover:text-ink-900"
    }`;

  return (
    <div>
      <div className="flex flex-col items-center justify-center gap-3 md:flex-row md:gap-6">
        <div role="radiogroup" aria-label={labels.toggleLabel} className="inline-flex rounded-xl bg-ink-50 p-1 ring-1 ring-inset ring-ink-100">
          {(["monthly", "yearly"] as const).map((p) => (
            <button key={p} type="button" role="radio" aria-checked={period === p} onClick={() => setPeriod(p)} className={segment(period === p)}>
              {labels[p]}
              {p === "yearly" && (
                <span className="rounded-full bg-go-50 px-1.5 py-0.5 text-[11px] font-medium text-go-600">{labels.yearlyBadge}</span>
              )}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-2.5">
          <span id="currency-label" className="text-sm text-ink-500">{labels.currency}:</span>
          <div role="radiogroup" aria-labelledby="currency-label" className="inline-flex rounded-xl bg-ink-50 p-1 ring-1 ring-inset ring-ink-100">
            {currencies.map((c) => (
              <button
                key={c.code}
                type="button"
                role="radio"
                aria-checked={currency === c.code}
                title={c.name}
                onClick={() => saveCurrency(c.code)}
                className={segment(currency === c.code)}
              >
                <span aria-hidden>{c.symbol}</span>
                <span className="text-xs tracking-wide" translate="no">{c.code}</span>
              </button>
            ))}
          </div>
        </div>
      </div>

      <ul className="mt-10 grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        {plans.map((plan) => {
          const monthly = plan.monthlyPrice[currency];
          const isFree = monthly === 0;
          const yearlyTotal = monthly * yearlyMonths;
          const shown = period === "monthly" ? monthly : yearlyTotal / 12;
          const note = isFree
            ? labels.free
            : period === "yearly"
              ? interpolate(labels.billedYearly, { amount: formatPrice(yearlyTotal, currency, intlLocale) })
              : "";
          return (
            <li
              key={plan.id}
              className={`relative flex flex-col rounded-2xl border bg-white p-6 ${
                plan.highlighted ? "border-ink-950 shadow-[var(--shadow-float)]" : "border-ink-100 shadow-[var(--shadow-card)]"
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-base font-semibold text-ink-950" translate="no">{plan.name}</h3>
                {plan.badge && (
                  <span className="rounded-full bg-ink-950 px-2 py-0.5 text-[11px] font-medium text-white">{plan.badge}</span>
                )}
              </div>
              <p className="mt-2 min-h-[3.75rem] text-sm leading-relaxed text-ink-500">{plan.description}</p>
              <p className="mt-6 flex flex-wrap items-baseline gap-x-1">
                <span className="text-4xl font-semibold tracking-[-0.03em] text-ink-950 tabular-nums">
                  {formatPrice(shown, currency, intlLocale)}
                </span>
                <span className="text-sm text-ink-400">{labels.perMonth}</span>
              </p>
              <p className="mt-1 min-h-5 text-xs text-ink-400">{note}</p>
              <Link
                href={`${plan.href}&currency=${currency}`}
                className={`${buttonClass(plan.highlighted ? "primary" : "secondary", "lg")} mt-6 w-full`}
              >
                {plan.cta}
              </Link>
              <ul className="mt-6 space-y-2.5 border-t border-ink-100 pt-6">
                {plan.items.map((item) => (
                  <li key={item} className="flex gap-2.5 text-sm text-ink-700">
                    <Check className="mt-0.5 size-4 shrink-0 text-go-600" aria-hidden />
                    {item}
                  </li>
                ))}
              </ul>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
