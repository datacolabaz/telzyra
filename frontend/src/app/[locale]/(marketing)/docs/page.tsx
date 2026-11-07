import { ArrowRight, Info, Mail, MessageCircle } from "lucide-react";
import { buildMetadata } from "@/i18n/seo";
import { getLocale, getTranslations } from "@/i18n/server";
import { localizedPath } from "@/i18n/routing";
import { ButtonLink, Container } from "@/components/ui/primitives";
import { KIND_STYLES, NodeIcon } from "@/components/marketing/NodeIcon";
import { NODE_CATALOGUE } from "@/engine/nodes";
import { SITE } from "@/config/site";

export const generateMetadata = () => buildMetadata("docs", "/docs");

const SECTIONS = ["overview", "concepts", "howItRuns", "firstWorkflow", "nodes", "limits", "help"] as const;

export default async function DocsPage() {
  const locale = await getLocale();
  const t = await getTranslations("docs");
  const tn = await getTranslations("nodes");
  const tc = await getTranslations("common");
  const concepts = t.raw("concepts.items");
  const whatsappUrl = `https://wa.me/${SITE.support.whatsapp}?text=${encodeURIComponent(tc("footer.whatsappMessage"))}`;

  const h2 = "text-xl font-semibold tracking-[-0.015em] text-ink-950";
  const body = "mt-3 leading-relaxed text-ink-700";

  return (
    <Container className="py-16 sm:py-20">
      <div className="grid gap-12 lg:grid-cols-[220px_1fr] lg:gap-16">
        <aside className="hidden lg:block">
          <nav aria-labelledby="docs-toc" className="sticky top-24">
            <p id="docs-toc" className="text-xs font-semibold uppercase tracking-wide text-ink-400">{t("contents")}</p>
            <ol className="mt-4 space-y-2.5 border-l border-ink-100">
              {SECTIONS.map((id) => (
                <li key={id}>
                  <a href={`#${id}`} className="-ml-px block border-l border-transparent pl-4 text-sm text-ink-500 hover:border-ink-950 hover:text-ink-950">
                    {t(`${id}.h`)}
                  </a>
                </li>
              ))}
            </ol>
          </nav>
        </aside>

        <article className="max-w-3xl">
          <h1 className="text-3xl font-semibold tracking-[-0.025em] text-ink-950 sm:text-4xl">{t("title")}</h1>
          <p className="mt-4 text-[17px] leading-relaxed text-ink-500">{t("intro")}</p>
          <p className="mt-6 flex gap-3 rounded-xl border border-ink-100 bg-ink-50 p-4 text-sm leading-relaxed text-ink-700">
            <Info className="mt-0.5 size-4 shrink-0 text-ink-400" aria-hidden />
            {t("status")}
          </p>

          <section id="overview" className="mt-12 scroll-mt-24">
            <h2 className={h2}>{t("overview.h")}</h2>
            {t.raw("overview.p").map((p) => <p key={p} className={body}>{p}</p>)}
          </section>

          <section id="concepts" className="mt-12 scroll-mt-24">
            <h2 className={h2}>{t("concepts.h")}</h2>
            <dl className="mt-4 divide-y divide-ink-100 rounded-xl border border-ink-100">
              {concepts.map((c) => (
                <div key={c.term} className="grid gap-1 px-5 py-4 sm:grid-cols-[180px_1fr] sm:gap-6">
                  <dt className="text-sm font-semibold text-ink-950">{c.term}</dt>
                  <dd className="text-sm leading-relaxed text-ink-700">{c.def}</dd>
                </div>
              ))}
            </dl>
          </section>

          {(["howItRuns", "firstWorkflow"] as const).map((id) => (
            <section key={id} id={id} className="mt-12 scroll-mt-24">
              <h2 className={h2}>{t(`${id}.h`)}</h2>
              <ol className="mt-4 space-y-3">
                {t.raw(`${id}.list`).map((step, i) => (
                  <li key={step} className="flex gap-4">
                    <span className="inline-flex size-7 shrink-0 items-center justify-center rounded-full bg-ink-950 text-xs font-semibold text-white">{i + 1}</span>
                    <span className="pt-0.5 leading-relaxed text-ink-700">{step}</span>
                  </li>
                ))}
              </ol>
            </section>
          ))}

          <section id="nodes" className="mt-12 scroll-mt-24">
            <h2 className={h2}>{t("nodes.h")}</h2>
            {t.raw("nodes.p").map((p) => <p key={p} className={body}>{p}</p>)}
            <ul className="mt-5 grid gap-3 sm:grid-cols-2">
              {NODE_CATALOGUE.map((node) => (
                <li key={node.id} className="rounded-xl border border-ink-100 p-4">
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
                  <p className="mt-3 text-[11px] text-ink-400">
                    {t("nodes.idLabel")}: <code className="font-mono text-ink-700" translate="no">{node.id}</code>
                  </p>
                </li>
              ))}
            </ul>
          </section>

          <section id="limits" className="mt-12 scroll-mt-24">
            <h2 className={h2}>{t("limits.h")}</h2>
            {t.raw("limits.p").map((p) => <p key={p} className={body}>{p}</p>)}
            <ButtonLink href={localizedPath(locale, "/pricing")} variant="secondary" className="mt-5">
              {t("limits.cta")}
              <ArrowRight className="size-4" aria-hidden />
            </ButtonLink>
          </section>

          <section id="help" className="mt-12 scroll-mt-24 rounded-2xl border border-ink-100 bg-ink-50/60 p-6">
            <h2 className={h2}>{t("help.h")}</h2>
            {t.raw("help.p").map((p) => <p key={p} className={body}>{p}</p>)}
            <div className="mt-5 flex flex-wrap gap-3">
              <a
                href={whatsappUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2 whitespace-nowrap rounded-lg bg-go-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-go-600/90"
              >
                <MessageCircle className="size-4" aria-hidden />
                {tc("footer.whatsapp")}
              </a>
              <a
                href={`mailto:${SITE.contactEmail}`}
                className="inline-flex items-center gap-2 rounded-lg bg-white px-4 py-2.5 text-sm font-medium text-ink-900 ring-1 ring-inset ring-ink-200 hover:bg-ink-50"
              >
                <Mail className="size-4" aria-hidden />
                {SITE.contactEmail}
              </a>
            </div>
          </section>
        </article>
      </div>
    </Container>
  );
}
