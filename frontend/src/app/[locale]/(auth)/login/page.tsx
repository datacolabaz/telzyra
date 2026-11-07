import Link from "next/link";
import { AuthForm } from "@/components/auth/AuthForm";
import { buildMetadata } from "@/i18n/seo";
import { localizedPath } from "@/i18n/routing";
import { getLocale, getTranslations } from "@/i18n/server";
import { loadNamespace } from "@/i18n/messages";

export const generateMetadata = () => buildMetadata("login", "/login", { index: false });

export default async function LoginPage() {
  const locale = await getLocale();
  const t = await getTranslations("auth");
  const errors = (await loadNamespace(locale, "validation")) as Record<string, string>;

  return (
    <>
      <h1 className="text-xl font-semibold tracking-[-0.02em] text-ink-950">{t("login.title")}</h1>
      <p className="mt-1.5 text-sm text-ink-500">{t("login.description")}</p>
      <div className="mt-6">
        <AuthForm
          mode="login"
          locale={locale}
          errors={errors}
          labels={{
            submit: t("login.submit"),
            submitting: t("status.submitting"),
            name: t("fields.name"),
            email: t("fields.email"),
            password: t("fields.password"),
            passwordHint: t("fields.passwordHint"),
          }}
        />
      </div>
      <p className="mt-6 text-center text-sm text-ink-500">
        {t("login.noAccount")}{" "}
        <Link href={localizedPath(locale, "/register")} className="font-medium text-ink-950 underline-offset-4 hover:underline">
          {t("login.register")}
        </Link>
      </p>
    </>
  );
}
