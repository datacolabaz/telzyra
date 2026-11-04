import {
  Activity,
  ArrowRight,
  Bell,
  Braces,
  ChartColumn,
  Copy,
  FileSearch,
  FileText,
  GitBranch,
  LayoutTemplate,
  Plug,
  Play,
  Settings2,
  ShoppingCart,
  Sparkles,
  TrendingUp,
  Unplug,
  UserPlus,
  Workflow,
  Zap,
  BellOff,
  type LucideIcon,
} from "lucide-react";
import { Badge, ButtonLink, Card, Container, IconTile, Section, SectionHeader } from "@/components/ui/primitives";
import { WorkflowPreview } from "./WorkflowPreview";
import { localizedPath } from "@/i18n/routing";
import { getLocale, getTranslations } from "@/i18n/server";
import { INTEGRATIONS, INTEGRATION_CATEGORIES } from "@/config/integrations";
import { USE_CASES, isUseCaseAvailable } from "@/config/use-cases";
import { getNode } from "@/engine/nodes";
import { NodeIcon } from "./NodeIcon";

/* ---------------------------------- Hero ---------------------------------- */

export async function Hero() {
  const locale = await getLocale();
  const t = await getTranslations("home");
  const c = await getTranslations("common");

  return (
    <section aria-labelledby="hero-title" className="relative overflow-hidden">
      <div aria-hidden className="bg-grid pointer-events-none absolute inset-0 [mask-image:radial-gradient(ellipse_at_top,black_30%,transparent_70%)]" />
      <Container className="relative pb-20 pt-16 sm:pb-28 sm:pt-24">
        <div className="mx-auto max-w-3xl text-center">
          <p className="mb-5 inline-flex items-center gap-2 rounded-full border border-ink-100 bg-white px-3 py-1 text-xs font-medium text-ink-700">
            <span className="size-1.5 rounded-full bg-go-600" aria-hidden />
            {t("hero.eyebrow")}
          </p>
          <h1 id="hero-title" className="text-4xl font-semibold tracking-[-0.035em] text-ink-950 sm:text-6xl text-balance">
            {t("hero.title")}
          </h1>
          <p className="mx-auto mt-6 max-w-xl text-lg leading-relaxed text-ink-500 text-pretty">
            {t("hero.description")}
          </p>
          <div className="mt-9 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <ButtonLink href={localizedPath(locale, "/register")} size="lg">
              {c("cta.startFree")}
              <ArrowRight className="size-4" aria-hidden />
            </ButtonLink>
            <ButtonLink href={localizedPath(locale, "/features")} variant="secondary" size="lg">
              {c("cta.explore")}
            </ButtonLink>
          </div>
          <p className="mt-4 text-sm text-ink-400">{t("hero.note")}</p>
        </div>
        <div className="mx-auto mt-16 max-w-5xl">
          <WorkflowPreview />
        </div>
      </Container>
    </section>
  );
}

/* -------------------------------- Problems -------------------------------- */

const PROBLEM_ICONS: Record<string, LucideIcon> = {
  dataEntry: Copy,
  reports: FileText,
  disconnected: Unplug,
  notifications: BellOff,
  communication: Bell,
};

export async function ProblemSection() {
  const t = await getTranslations("home");
  const keys = ["dataEntry", "reports", "disconnected", "notifications", "communication"] as const;

  return (
    <Section labelledBy="problem-title" className="border-t border-ink-100 bg-ink-50/50">
      <div className="grid gap-12 lg:grid-cols-[1fr_1.4fr] lg:gap-16">
        <SectionHeader id="problem-title" title={t("problem.title")} description={t("problem.description")} />
        <ul className="grid gap-px overflow-hidden rounded-2xl border border-ink-100 bg-ink-100 sm:grid-cols-2">
          {keys.map((k, i) => {
            const Icon = PROBLEM_ICONS[k]!;
            return (
              <li key={k} className={`bg-white p-6 ${i === keys.length - 1 ? "sm:col-span-2" : ""}`}>
                <Icon className="size-5 text-ink-400" aria-hidden />
                <h3 className="mt-4 text-[15px] font-semibold text-ink-950">{t(`problem.items.${k}.title`)}</h3>
                <p className="mt-1.5 text-sm leading-relaxed text-ink-500">{t(`problem.items.${k}.description`)}</p>
              </li>
            );
          })}
        </ul>
      </div>
    </Section>
  );
}

/* -------------------------------- Features -------------------------------- */

export const FEATURE_KEYS = [
  "builder",
  "integrations",
  "ai",
  "triggers",
  "logic",
  "monitoring",
  "webhooks",
  "templates",
] as const;

const FEATURE_ICONS: Record<(typeof FEATURE_KEYS)[number], LucideIcon> = {
  builder: Workflow,
  integrations: Plug,
  ai: Sparkles,
  triggers: Zap,
  logic: GitBranch,
  monitoring: Activity,
  webhooks: Braces,
  templates: LayoutTemplate,
};

export async function FeatureGrid() {
  const t = await getTranslations("features");
  return (
    <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      {FEATURE_KEYS.map((k) => {
        const Icon = FEATURE_ICONS[k];
        return (
          <li key={k}>
            <Card className="h-full">
              <IconTile>
                <Icon className="size-[18px]" aria-hidden />
              </IconTile>
              <h3 className="mt-5 text-[15px] font-semibold text-ink-950">{t(`items.${k}.title`)}</h3>
              <p className="mt-2 text-sm leading-relaxed text-ink-500">{t(`items.${k}.description`)}</p>
            </Card>
          </li>
        );
      })}
    </ul>
  );
}

export async function FeaturesSection() {
  const t = await getTranslations("home");
  return (
    <Section id="features" labelledBy="features-title">
      <SectionHeader
        id="features-title"
        eyebrow={t("features.eyebrow")}
        title={t("features.title")}
        description={t("features.description")}
      />
      <div className="mt-12">
        <FeatureGrid />
      </div>
    </Section>
  );
}

/* ------------------------------ How it works ------------------------------ */

const STEP_ICONS: Record<string, LucideIcon> = { trigger: Zap, connect: Plug, configure: Settings2, activate: Play };

export async function HowItWorks() {
  const t = await getTranslations("home");
  const steps = ["trigger", "connect", "configure", "activate"] as const;

  return (
    <Section labelledBy="how-title" className="border-y border-ink-100 bg-ink-950 text-white">
      <div className="max-w-2xl">
        <p className="mb-3 text-sm font-medium text-emerald-300">{t("howItWorks.eyebrow")}</p>
        <h2 id="how-title" className="text-3xl font-semibold tracking-[-0.025em] sm:text-4xl text-balance">
          {t("howItWorks.title")}
        </h2>
      </div>
      <ol className="mt-14 grid gap-8 md:grid-cols-4 md:gap-0">
        {steps.map((s, i) => {
          const Icon = STEP_ICONS[s]!;
          return (
            <li key={s} className="relative md:pr-8">
              <div className="flex items-center">
                <span className="inline-flex size-10 items-center justify-center rounded-xl bg-white/10 ring-1 ring-inset ring-white/15">
                  <Icon className="size-[18px]" aria-hidden />
                </span>
                {i < steps.length - 1 && <span aria-hidden className="ml-4 hidden h-px flex-1 bg-white/15 md:block" />}
              </div>
              <p className="mt-6 font-mono text-xs text-white/40">0{i + 1}</p>
              <h3 className="mt-1.5 text-base font-semibold">{t(`howItWorks.steps.${s}.title`)}</h3>
              <p className="mt-2 text-sm leading-relaxed text-white/60">{t(`howItWorks.steps.${s}.description`)}</p>
            </li>
          );
        })}
      </ol>
    </Section>
  );
}

/* ------------------------------ Integrations ------------------------------ */

export async function IntegrationsSection() {
  const locale = await getLocale();
  const t = await getTranslations("home");
  const ti = await getTranslations("integrations");

  return (
    <Section id="integrations" labelledBy="integrations-title">
      <div className="flex flex-col justify-between gap-8 md:flex-row md:items-end">
        <SectionHeader
          id="integrations-title"
          eyebrow={t("integrations.eyebrow")}
          title={t("integrations.title")}
          description={t("integrations.description")}
        />
        <ButtonLink href={localizedPath(locale, "/integrations")} variant="secondary">
          {t("integrations.viewAll")}
          <ArrowRight className="size-4" aria-hidden />
        </ButtonLink>
      </div>
      <ul className="mt-12 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {INTEGRATION_CATEGORIES.map((cat) => {
          const items = INTEGRATIONS.filter((i) => i.category === cat);
          const available = items.filter((i) => i.status === "available").length;
          return (
            <li key={cat} className="rounded-xl border border-ink-100 p-5">
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-sm font-semibold text-ink-950">{ti(`categories.${cat}`)}</h3>
                <Badge tone={available ? "go" : "neutral"}>
                  {available ? ti("status.available") : ti("status.planned")}
                </Badge>
              </div>
              <p className="mt-3 text-sm text-ink-500" translate="no">
                {items.map((i) => i.name).join(" · ")}
              </p>
            </li>
          );
        })}
        <li className="rounded-xl border border-dashed border-ink-200 bg-ink-50/60 p-5">
          <h3 className="text-sm font-semibold text-ink-950">{ti("universal.title")}</h3>
          <p className="mt-3 text-sm leading-relaxed text-ink-500">{ti("universal.description")}</p>
        </li>
      </ul>
    </Section>
  );
}

/* -------------------------------- Use cases ------------------------------- */

const USE_CASE_ICONS: Record<string, LucideIcon> = {
  userPlus: UserPlus,
  cart: ShoppingCart,
  bell: Bell,
  chart: ChartColumn,
  fileSearch: FileSearch,
  trendingUp: TrendingUp,
};

export async function UseCases() {
  const t = await getTranslations("home");
  const c = await getTranslations("common");
  const tn = await getTranslations("nodes");

  return (
    <Section id="use-cases" labelledBy="use-cases-title" className="border-t border-ink-100 bg-ink-50/50">
      <SectionHeader
        id="use-cases-title"
        eyebrow={t("useCases.eyebrow")}
        title={t("useCases.title")}
        description={t("useCases.description")}
      />
      <ul className="mt-12 grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {USE_CASES.map((u) => {
          const Icon = USE_CASE_ICONS[u.icon]!;
          const live = isUseCaseAvailable(u);
          return (
            <li key={u.key}>
              <Card className="flex h-full flex-col">
                <div className="flex items-start justify-between gap-3">
                  <IconTile>
                    <Icon className="size-[18px]" aria-hidden />
                  </IconTile>
                  {!live && <Badge tone="warn">{c("labels.demo")}</Badge>}
                </div>
                <h3 className="mt-5 text-[15px] font-semibold text-ink-950">{t(`useCases.items.${u.key}.title`)}</h3>
                <p className="mt-2 flex-1 text-sm leading-relaxed text-ink-500">
                  {t(`useCases.items.${u.key}.description`)}
                </p>
                <ol className="mt-5 flex flex-wrap items-center gap-1.5">
                  {u.nodes.map((id, i) => (
                    <li key={id} className="flex items-center gap-1.5">
                      <span className="inline-flex items-center gap-1 rounded-md bg-ink-50 px-2 py-1 text-xs text-ink-700 ring-1 ring-inset ring-ink-100">
                        <NodeIcon node={getNode(id)} className="size-3" />
                        {tn(`${id}.label`)}
                      </span>
                      {i < u.nodes.length - 1 && <ArrowRight className="size-3 text-ink-300" aria-hidden />}
                    </li>
                  ))}
                </ol>
              </Card>
            </li>
          );
        })}
      </ul>
    </Section>
  );
}

/* ----------------------------------- FAQ ---------------------------------- */

export async function Faq() {
  const t = await getTranslations("home");
  const items = t.raw("faq.items");

  return (
    <Section id="faq" labelledBy="faq-title">
      <div className="grid gap-12 lg:grid-cols-[1fr_1.6fr]">
        <SectionHeader id="faq-title" eyebrow={t("faq.eyebrow")} title={t("faq.title")} />
        <div className="divide-y divide-ink-100 border-y border-ink-100">
          {items.map((item) => (
            <details key={item.q} className="group py-5">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-6 text-[15px] font-medium text-ink-950 [&::-webkit-details-marker]:hidden">
                {item.q}
                <span aria-hidden className="text-xl leading-none text-ink-400 transition-transform group-open:rotate-45">+</span>
              </summary>
              <p className="mt-3 pr-10 text-sm leading-relaxed text-ink-500">{item.a}</p>
            </details>
          ))}
        </div>
      </div>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify({
            "@context": "https://schema.org",
            "@type": "FAQPage",
            mainEntity: items.map((i) => ({
              "@type": "Question",
              name: i.q,
              acceptedAnswer: { "@type": "Answer", text: i.a },
            })),
          }).replace(/</g, "\\u003c"),
        }}
      />
    </Section>
  );
}

/* -------------------------------- Final CTA ------------------------------- */

export async function FinalCta() {
  const locale = await getLocale();
  const t = await getTranslations("home");
  const c = await getTranslations("common");
  return (
    <section aria-labelledby="final-cta-title" className="pb-24">
      <Container>
        <div className="relative overflow-hidden rounded-3xl bg-ink-950 px-6 py-16 text-center sm:px-12 sm:py-20">
          <div aria-hidden className="bg-grid pointer-events-none absolute inset-0 opacity-[0.07] invert" />
          <h2 id="final-cta-title" className="relative text-3xl font-semibold tracking-[-0.025em] text-white sm:text-4xl text-balance">
            {t("finalCta.title")}
          </h2>
          <p className="relative mx-auto mt-4 max-w-lg text-[17px] text-white/60">{t("finalCta.description")}</p>
          <div className="relative mt-8">
            <ButtonLink
              href={localizedPath(locale, "/register")}
              size="lg"
              className="!bg-white !text-ink-950 hover:!bg-ink-100"
            >
              {c("cta.createAccount")}
              <ArrowRight className="size-4" aria-hidden />
            </ButtonLink>
          </div>
        </div>
      </Container>
    </section>
  );
}
