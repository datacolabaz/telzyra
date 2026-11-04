"use client";

import Link from "next/link";
import { useState } from "react";
import { Check } from "lucide-react";
import { buttonClass } from "@/components/ui/primitives";

type Period = "monthly" | "yearly";

export interface PricingCardData {
  id: string;
  name: string;
  description: string;
  cta: string;
  href: string;
  badge?: string;
  highlighted?: boolean;
  price: Record<Period, { amount: string; suffix: string; note: string }>;
  items: string[];
}

/** All copy arrives pre-localized from the server; this component only holds UI state. */
export function PricingTable({
  plans,
  labels,
}: {
  plans: PricingCardData[];
  labels: { monthly: string; yearly: string; yearlyBadge: string; toggleLabel: string };
}) {
  const [period, setPeriod] = useState<Period>("monthly");

  return (
    <div>
      <div className="flex justify-center">
        <div role="radiogroup" aria-label={labels.toggleLabel} className="inline-flex rounded-xl bg-ink-50 p-1 ring-1 ring-inset ring-ink-100">
          {(["monthly", "yearly"] as const).map((p) => (
            <button
              key={p}
              type="button"
              role="radio"
              aria-checked={period === p}
              onClick={() => setPeriod(p)}
              className={`inline-flex h-9 items-center gap-2 rounded-lg px-4 text-sm font-medium transition-colors ${
                period === p ? "bg-white text-ink-950 shadow-[var(--shadow-card)]" : "text-ink-500 hover:text-ink-900"
              }`}
            >
              {labels[p]}
              {p === "yearly" && (
                <span className="rounded-full bg-go-50 px-1.5 py-0.5 text-[11px] font-medium text-go-600">
                  {labels.yearlyBadge}
                </span>
              )}
            </button>
          ))}
        </div>
      </div>

      <ul className="mt-10 grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        {plans.map((plan) => {
          const price = plan.price[period];
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
              <p className="mt-6 flex items-baseline gap-1">
                <span className="text-4xl font-semibold tracking-[-0.03em] text-ink-950 tabular-nums">{price.amount}</span>
                <span className="text-sm text-ink-400">{price.suffix}</span>
              </p>
              <p className="mt-1 min-h-5 text-xs text-ink-400">{price.note}</p>
              <Link
                href={plan.href}
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
