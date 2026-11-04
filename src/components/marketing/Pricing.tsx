import { BILLING, getPlans } from "@/config/plans";
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
    const yearlyTotal = p.monthlyPrice * BILLING.yearlyMonths;
    const isFree = p.monthlyPrice === 0;
    const l = p.limits;
    return {
      id: p.id,
      name: t(`plans.${p.id}.name`),
      description: t(`plans.${p.id}.description`),
      cta: t(`plans.${p.id}.cta`),
      badge: p.id === "pro" ? t("plans.pro.badge") : undefined,
      highlighted: p.highlighted,
      href: `${localizedPath(locale, "/register")}?plan=${p.id}`,
      price: {
        monthly: {
          amount: fmt.currency(p.monthlyPrice),
          suffix: t("price.perMonth"),
          note: isFree ? t("price.free") : "",
        },
        yearly: {
          amount: fmt.currency(Math.round((yearlyTotal / 12) * 100) / 100),
          suffix: t("price.perMonth"),
          note: isFree ? t("price.free") : t("price.billedYearly", { amount: fmt.currency(yearlyTotal) }),
        },
      },
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
        labels={{
          monthly: t("billing.monthly"),
          yearly: t("billing.yearly"),
          yearlyBadge: t("billing.yearlyBadge"),
          toggleLabel: t("billing.toggleLabel"),
        }}
      />
      <p className="mt-8 text-center text-xs text-ink-400">{t("footnote")}</p>
    </>
  );
}
