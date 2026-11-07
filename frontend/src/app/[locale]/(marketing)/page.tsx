import { buildMetadata } from "@/i18n/seo";
import { getTranslations } from "@/i18n/server";
import { Section, SectionHeader } from "@/components/ui/primitives";
import { Pricing } from "@/components/marketing/Pricing";
import {
  Faq,
  FeaturesSection,
  FinalCta,
  Hero,
  HowItWorks,
  IntegrationsSection,
  ProblemSection,
  UseCases,
} from "@/components/marketing/sections";
import { SITE } from "@/config/site";

export const generateMetadata = () => buildMetadata("home", "/");

export default async function HomePage() {
  const t = await getTranslations("home");
  const seo = await getTranslations("seo");

  return (
    <>
      <Hero />
      <ProblemSection />
      <FeaturesSection />
      <HowItWorks />
      <IntegrationsSection />
      <UseCases />
      <Section id="pricing" labelledBy="pricing-title" className="border-t border-ink-100">
        <SectionHeader
          id="pricing-title"
          eyebrow={t("pricing.eyebrow")}
          title={t("pricing.title")}
          description={t("pricing.description")}
          align="center"
        />
        <div className="mt-12">
          <Pricing />
        </div>
      </Section>
      <Faq />
      <FinalCta />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify({
            "@context": "https://schema.org",
            "@type": "SoftwareApplication",
            name: SITE.name,
            applicationCategory: "BusinessApplication",
            operatingSystem: "Web",
            description: seo("home.description"),
            url: SITE.url,
          }).replace(/</g, "\\u003c"),
        }}
      />
    </>
  );
}
