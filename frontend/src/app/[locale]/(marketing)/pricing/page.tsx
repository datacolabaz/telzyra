import { buildMetadata } from "@/i18n/seo";
import { getTranslations } from "@/i18n/server";
import { Section, SectionHeader } from "@/components/ui/primitives";
import { Pricing } from "@/components/marketing/Pricing";
import { Faq, FinalCta } from "@/components/marketing/sections";

export const generateMetadata = () => buildMetadata("pricing", "/pricing");

export default async function PricingPage() {
  const t = await getTranslations("pricing");
  return (
    <>
      <Section labelledBy="pricing-page-title" className="!pt-16 sm:!pt-20">
        <SectionHeader
          id="pricing-page-title"
          eyebrow={t("page.eyebrow")}
          title={t("page.title")}
          description={t("page.description")}
          align="center"
        />
        <div className="mt-12">
          <Pricing />
        </div>
      </Section>
      <Faq />
      <FinalCta />
    </>
  );
}
