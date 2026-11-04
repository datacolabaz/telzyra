import { buildMetadata } from "@/i18n/seo";
import { getTranslations } from "@/i18n/server";
import { Section, SectionHeader } from "@/components/ui/primitives";
import { FeatureGrid, FinalCta, HowItWorks } from "@/components/marketing/sections";
import { WorkflowPreview } from "@/components/marketing/WorkflowPreview";
import { KIND_STYLES, NodeIcon } from "@/components/marketing/NodeIcon";
import { NODE_CATALOGUE } from "@/engine/nodes";

export const generateMetadata = () => buildMetadata("features", "/features");

export default async function FeaturesPage() {
  const t = await getTranslations("features");
  const tn = await getTranslations("nodes");

  return (
    <>
      <Section labelledBy="features-page-title" className="!pt-16 sm:!pt-20">
        <SectionHeader id="features-page-title" eyebrow={t("page.eyebrow")} title={t("page.title")} description={t("page.description")} />
        <div className="mt-12">
          <WorkflowPreview />
        </div>
        <div className="mt-16">
          <FeatureGrid />
        </div>
      </Section>

      <HowItWorks />

      <Section labelledBy="nodes-title">
        <SectionHeader id="nodes-title" title={t("nodesSection.title")} description={t("nodesSection.description")} />
        <ul className="mt-10 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {NODE_CATALOGUE.map((node) => (
            <li key={node.id} className="rounded-xl border border-ink-100 p-5">
              <div className="flex items-center gap-2.5">
                <span className={`inline-flex size-8 items-center justify-center rounded-lg ring-1 ring-inset ${KIND_STYLES[node.kind]}`}>
                  <NodeIcon node={node} />
                </span>
                <div>
                  <p className="text-[11px] font-medium uppercase tracking-wide text-ink-400">{tn(`kinds.${node.kind}`)}</p>
                  <h3 className="text-sm font-semibold text-ink-950">{tn(`${node.id}.label`)}</h3>
                </div>
              </div>
              <p className="mt-3 text-sm leading-relaxed text-ink-500">{tn(`${node.id}.description`)}</p>
              <code className="mt-3 block font-mono text-[11px] text-ink-400" translate="no">{node.id}</code>
            </li>
          ))}
        </ul>
      </Section>

      <FinalCta />
    </>
  );
}
