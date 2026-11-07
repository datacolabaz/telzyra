import { Info } from "lucide-react";
import { buildMetadata } from "@/i18n/seo";
import { getTranslations } from "@/i18n/server";
import { Badge, ButtonLink, Section, SectionHeader } from "@/components/ui/primitives";
import { FinalCta } from "@/components/marketing/sections";
import { INTEGRATIONS, INTEGRATION_CATEGORIES, type IntegrationStatus } from "@/config/integrations";
import { SITE } from "@/config/site";

export const generateMetadata = () => buildMetadata("integrations", "/integrations");

const STATUS_TONE: Record<IntegrationStatus, "go" | "brand" | "neutral"> = {
  available: "go",
  beta: "brand",
  planned: "neutral",
};

export default async function IntegrationsPage() {
  const t = await getTranslations("integrations");
  const anyLive = INTEGRATIONS.some((i) => i.status === "available");

  return (
    <>
      <Section labelledBy="integrations-page-title" className="!pt-16 sm:!pt-20">
        <SectionHeader id="integrations-page-title" eyebrow={t("page.eyebrow")} title={t("page.title")} description={t("page.description")} />

        {!anyLive && (
          <p className="mt-8 flex max-w-3xl gap-3 rounded-xl border border-ink-100 bg-ink-50 p-4 text-sm leading-relaxed text-ink-700">
            <Info className="mt-0.5 size-4 shrink-0 text-ink-400" aria-hidden />
            {t("notice")}
          </p>
        )}

        <div className="mt-12 space-y-10">
          {INTEGRATION_CATEGORIES.map((cat) => {
            const items = INTEGRATIONS.filter((i) => i.category === cat);
            if (!items.length) return null;
            return (
              <section key={cat} aria-labelledby={`cat-${cat}`}>
                <h2 id={`cat-${cat}`} className="text-sm font-semibold text-ink-950">{t(`categories.${cat}`)}</h2>
                <ul className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                  {items.map((i) => (
                    <li key={i.id} className="flex items-center justify-between rounded-xl border border-ink-100 px-4 py-3.5">
                      <span className="flex items-center gap-3">
                        <span aria-hidden className="inline-flex size-8 items-center justify-center rounded-lg bg-ink-50 text-xs font-semibold text-ink-700 ring-1 ring-inset ring-ink-100">
                          {i.name.slice(0, 2)}
                        </span>
                        <span className="text-sm font-medium text-ink-900" translate="no">{i.name}</span>
                      </span>
                      <Badge tone={STATUS_TONE[i.status]}>{t(`status.${i.status}`)}</Badge>
                    </li>
                  ))}
                </ul>
              </section>
            );
          })}
        </div>

        <div className="mt-16 grid gap-4 md:grid-cols-2">
          <div className="rounded-2xl border border-dashed border-ink-200 bg-ink-50/60 p-6">
            <h2 className="text-base font-semibold text-ink-950">{t("universal.title")}</h2>
            <p className="mt-2 text-sm leading-relaxed text-ink-500">{t("universal.description")}</p>
          </div>
          <div className="rounded-2xl border border-ink-100 p-6">
            <h2 className="text-base font-semibold text-ink-950">{t("request.title")}</h2>
            <p className="mt-2 text-sm leading-relaxed text-ink-500">{t("request.description")}</p>
            <ButtonLink href={`mailto:${SITE.contactEmail}?subject=${encodeURIComponent(t("request.cta"))}`} variant="secondary" className="mt-5">
              {t("request.cta")}
            </ButtonLink>
          </div>
        </div>
      </Section>
      <FinalCta />
    </>
  );
}
