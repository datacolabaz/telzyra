import { Suspense } from "react";
import { redirect } from "next/navigation";
import { buildMetadata } from "@/i18n/seo";
import { getLocale, getTranslations } from "@/i18n/server";
import { loadNamespace } from "@/i18n/messages";
import { LOCALES } from "@/i18n/config";
import { localizedPath } from "@/i18n/routing";
import { Container } from "@/components/ui/primitives";
import { IntegrationsView } from "@/components/app/IntegrationsView";
import { getCurrentSession } from "@/lib/auth/session";
import { SITE } from "@/config/site";

export const generateMetadata = () => buildMetadata("dashboard", "/dashboard/integrations", { index: false });

async function Content({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const locale = await getLocale();
  const session = await getCurrentSession();
  if (!session) redirect(localizedPath(locale, "/login"));
  const [t, messages, sp] = await Promise.all([getTranslations("app"), loadNamespace(locale, "app"), searchParams]);
  const one = (v: string | string[] | undefined) => (typeof v === "string" ? v.slice(0, 100) : undefined);
  return (
    <Container className="py-12">
      <h1 className="text-2xl font-semibold tracking-[-0.02em] text-ink-950">{t("integrations.title")}</h1>
      <p className="mt-1.5 mb-8 text-sm text-ink-500">{t("integrations.subtitle")}</p>
      <IntegrationsView
        apiUrl={SITE.publicApiUrl}
        csrfToken={session.csrfToken}
        canManage={session.role !== "MEMBER"}
        messages={messages}
        dateLocale={LOCALES[locale].intl}
        result={{ status: one(sp.status), reason: one(sp.reason) }}
        workflowsHref={localizedPath(locale, "/dashboard/workflows")}
      />
    </Container>
  );
}

export default function IntegrationsPage(props: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  return (
    <Suspense fallback={<Container className="py-12"><div className="h-7 w-48 animate-pulse rounded-md bg-ink-100" /></Container>}>
      <Content searchParams={props.searchParams} />
    </Suspense>
  );
}
