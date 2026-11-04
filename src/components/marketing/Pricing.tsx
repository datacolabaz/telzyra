import { BILLING, getPlans } from "@/config/plans";
import { CURRENCIES, CURRENCY_ORDER } from "@/config/currency";
import { LOCALES } from "@/i18n/config";
import { localizedPath } from "@/i18n/routing";
import { getFormatters, getLocale, getTranslations } from "@/i18n/server";
import { PricingTable, type PricingCardData } from "./PricingTable";

/** Server wrapper: resolves plans + localized copy, hands plain data to the client table. */
export async function Pricing() {
  const locale = await getLocale();
  const t = await getTranslations("pricing");
  const fmt = await getFormatters();
  const plans = await getPlans();

  const cards: PricingCardData[] = plans.map((p) => {
    const l = p.limits;
    return {
      id: p.id,
      name: t(`plans.${p.id}.name`),
      description: t(`plans.${p.id}.description`),
      cta: t(`plans.${p.id}.cta`),
      badge: p.id === "pro" ? t("plans.pro.badge") : undefined,
      highlighted: p.highlighted,
      href: `${localizedPath(locale, "/register")}?plan=${p.id}`,
      monthlyPrice: p.monthlyPrice,
      items: [
        t("limits.operations", { count: fmt.number(l.operationsPerMonth) }),
        l.activeWorkflows === null
          ? t("limits.workflowsUnlimited")
          : t("limits.workflows", { count: fmt.number(l.activeWorkflows) }),
        t("limits.schedule", { count: l.minScheduleMinutes }),
        t("limits.history", { count: l.historyDays }),
        l.members === 1 ? t("limits.member") : t("limits.members", { count: l.members }),
        ...p.features.map((f) => t(`features.${f}`)),
      ],
    };
  });

  return (
    <>
      <PricingTable
        plans={cards}
        intlLocale={LOCALES[locale].intl}
        defaultCurrency={LOCALES[locale].defaultCurrency}
        yearlyMonths={BILLING.yearlyMonths}
        currencies={CURRENCY_ORDER.map((code) => ({
          code,
          symbol: CURRENCIES[code].symbol,
          name: t(`currency.names.${code}`),
        }))}
        labels={{
          monthly: t("billing.monthly"),
          yearly: t("billing.yearly"),
          yearlyBadge: t("billing.yearlyBadge"),
          toggleLabel: t("billing.toggleLabel"),
          currency: t("currency.label"),
          perMonth: t("price.perMonth"),
          free: t("price.free"),
          billedYearly: t("price.billedYearly"),
        }}
      />
      <p className="mt-8 text-center text-xs text-ink-400">{t("footnote")}</p>
    </>
  );
}
