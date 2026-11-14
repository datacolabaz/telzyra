import { Suspense } from "react";
import { redirect } from "next/navigation";
import { buildMetadata } from "@/i18n/seo";
import { getLocale, getTranslations } from "@/i18n/server";
import { loadNamespace } from "@/i18n/messages";
import { LOCALES } from "@/i18n/config";
import { localizedPath } from "@/i18n/routing";
import { Container } from "@/components/ui/primitives";
import { WorkflowsView } from "@/components/app/WorkflowsView";
import { getCurrentSession } from "@/lib/auth/session";
import { SITE } from "@/config/site";

export const generateMetadata = () => buildMetadata("dashboard", "/dashboard/workflows", { index: false });

async function Content() {
  const locale = await getLocale();
  const session = await getCurrentSession();
  if (!session) redirect(localizedPath(locale, "/login"));
  const [t, messages] = await Promise.all([getTranslations("app"), loadNamespace(locale, "app")]);
  return (
    <Container className="py-12">
      <h1 className="text-2xl font-semibold tracking-[-0.02em] text-ink-950">{t("workflows.title")}</h1>
      <p className="mt-1.5 mb-8 text-sm text-ink-500">{t("workflows.subtitle")}</p>
      <WorkflowsView apiUrl={SITE.publicApiUrl} csrfToken={session.csrfToken} messages={messages} dateLocale={LOCALES[locale].intl} integrationsHref={localizedPath(locale, "/dashboard/integrations")} />
    </Container>
  );
}

export default function WorkflowsPage() {
  return (
    <Suspense fallback={<Container className="py-12"><div className="h-7 w-48 animate-pulse rounded-md bg-ink-100" /></Container>}>
      <Content />
    </Suspense>
  );
}
