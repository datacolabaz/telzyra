import Link from "next/link";
import { SITE } from "@/config/site";
import { Suspense } from "react";
import { AuthForm } from "@/components/auth/AuthForm";
import { buildMetadata } from "@/i18n/seo";
import { localizedPath } from "@/i18n/routing";
import { getLocale, getTranslations } from "@/i18n/server";
import { loadNamespace } from "@/i18n/messages";
import { PLANS, type PlanId } from "@/config/plans";

export const generateMetadata = () => buildMetadata("register", "/register", { index: false });

async function RegisterForm({ searchParams }: { searchParams: Promise<{ plan?: string }> }) {
  const locale = await getLocale();
  const t = await getTranslations("auth");
  const tp = await getTranslations("pricing");
  const errors = (await loadNamespace(locale, "validation")) as Record<string, string>;
  const requested = (await searchParams).plan;
  const plan = PLANS.find((p) => p.id === requested)?.id as PlanId | undefined;

  return (
    <>
      {plan && (
        <p className="mb-4 inline-flex rounded-full bg-brand-50 px-2.5 py-1 text-xs font-medium text-brand-600">
          {t("register.selectedPlan", { plan: tp(`plans.${plan}.name`) })}
        </p>
      )}
      <AuthForm
        mode="register"
        locale={locale}
        apiUrl={SITE.publicApiUrl}
        plan={plan}
        errors={errors}
        labels={{
          submit: t("register.submit"),
          submitting: t("status.submitting"),
          name: t("fields.name"),
          email: t("fields.email"),
          password: t("fields.password"),
          passwordHint: t("fields.passwordHint"),
        }}
      />
    </>
  );
}

export default async function RegisterPage({ searchParams }: PageProps<"/[locale]/register">) {
  const locale = await getLocale();
  const t = await getTranslations("auth");
  const c = await getTranslations("common");

  return (
    <>
      <h1 className="text-xl font-semibold tracking-[-0.02em] text-ink-950">{t("register.title")}</h1>
      <p className="mt-1.5 text-sm text-ink-500">{t("register.description")}</p>
      <div className="mt-6">
        <Suspense>
          <RegisterForm searchParams={searchParams as Promise<{ plan?: string }>} />
        </Suspense>
      </div>
      <p className="mt-4 text-xs leading-relaxed text-ink-400">{t("register.terms")}</p>
      <p className="mt-1.5 flex gap-3 text-xs">
        <Link href={localizedPath(locale, "/terms")} className="text-ink-700 underline underline-offset-2 hover:text-ink-950">
          {c("footer.terms")}
        </Link>
        <Link href={localizedPath(locale, "/privacy")} className="text-ink-700 underline underline-offset-2 hover:text-ink-950">
          {c("footer.privacy")}
        </Link>
      </p>
      <p className="mt-6 text-center text-sm text-ink-500">
        {t("register.hasAccount")}{" "}
        <Link href={localizedPath(locale, "/login")} className="font-medium text-ink-950 underline-offset-4 hover:underline">
          {t("register.login")}
        </Link>
      </p>
    </>
  );
}
