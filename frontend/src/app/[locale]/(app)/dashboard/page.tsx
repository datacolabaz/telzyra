import { Suspense } from "react";
import { redirect } from "next/navigation";
import { Building2, Mail, Plug, ShieldCheck, UserRound } from "lucide-react";
import { buildMetadata } from "@/i18n/seo";
import { getLocale, getTranslations } from "@/i18n/server";
import { localizedPath } from "@/i18n/routing";
import { Badge, Card, Container, IconTile } from "@/components/ui/primitives";
import { LogoutButton } from "@/components/app/LogoutButton";
import { getCurrentSession } from "@/lib/auth/session";
import { SITE } from "@/config/site";

export const generateMetadata = () => buildMetadata("dashboard", "/dashboard", { index: false });

async function DashboardContent() {
  const locale = await getLocale();
  const t = await getTranslations("app");
  const session = await getCurrentSession();
  if (!session) redirect(localizedPath(locale, "/login"));

  const rows = [
    { icon: UserRound, label: t("dashboard.name"), value: session.user.name },
    {
      icon: Mail,
      label: t("dashboard.email"),
      value: session.user.email,
      badge: session.user.emailVerified ? undefined : t("dashboard.emailNotVerified"),
    },
    { icon: Building2, label: t("dashboard.workspace"), value: session.workspace.name },
    { icon: ShieldCheck, label: t("dashboard.role"), value: t(`dashboard.roles.${session.role}`) },
  ];

  return (
    <Container className="py-12">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-[-0.02em] text-ink-950">
            {t("dashboard.title", { name: session.user.name.split(" ")[0] })}
          </h1>
          <p className="mt-1.5 text-sm text-ink-500">{t("dashboard.subtitle")}</p>
        </div>
        <LogoutButton
          apiUrl={SITE.publicApiUrl}
          csrfToken={session.csrfToken}
          redirectTo={localizedPath(locale, "/login")}
          label={t("dashboard.logout")}
        />
      </div>

      <div className="mt-8 grid gap-4 lg:grid-cols-[1fr_1fr]">
        <Card>
          <h2 className="text-sm font-semibold text-ink-950">{t("dashboard.account")}</h2>
          <dl className="mt-4 divide-y divide-ink-100">
            {rows.map(({ icon: Icon, label, value, badge }) => (
              <div key={label} className="flex items-center gap-3 py-3">
                <Icon className="size-4 text-ink-400" aria-hidden />
                <dt className="w-28 text-sm text-ink-500">{label}</dt>
                <dd className="flex flex-1 flex-wrap items-center gap-2 text-sm font-medium text-ink-900">
                  {value}
                  {badge && <Badge tone="warn">{badge}</Badge>}
                </dd>
              </div>
            ))}
          </dl>
        </Card>
        <Card>
          <IconTile>
            <Plug className="size-[18px]" aria-hidden />
          </IconTile>
          <h2 className="mt-4 text-sm font-semibold text-ink-950">{t("dashboard.nextTitle")}</h2>
          <p className="mt-2 text-sm leading-relaxed text-ink-500">{t("dashboard.nextBody")}</p>
        </Card>
      </div>
    </Container>
  );
}

function DashboardSkeleton() {
  return (
    <Container className="py-12" aria-busy="true">
      <div className="h-7 w-64 animate-pulse rounded-md bg-ink-100" />
      <div className="mt-8 grid gap-4 lg:grid-cols-2">
        <div className="h-56 animate-pulse rounded-2xl bg-white" />
        <div className="h-56 animate-pulse rounded-2xl bg-white" />
      </div>
    </Container>
  );
}

export default function DashboardPage() {
  return (
    <Suspense fallback={<DashboardSkeleton />}>
      <DashboardContent />
    </Suspense>
  );
}
