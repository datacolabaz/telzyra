import { Header } from "@/components/marketing/Header";
import { Footer } from "@/components/marketing/Footer";
import { ButtonLink, Container } from "@/components/ui/primitives";
import { localizedPath } from "@/i18n/routing";
import { getLocale, getTranslations } from "@/i18n/server";

export default async function NotFound() {
  const locale = await getLocale();
  const t = await getTranslations("common");
  return (
    <>
      <Header />
      <main id="main">
        <Container className="py-32 text-center">
          <p className="font-mono text-sm text-ink-400">404</p>
          <h1 className="mt-3 text-3xl font-semibold tracking-[-0.025em] text-ink-950">{t("notFound.title")}</h1>
          <p className="mt-3 text-ink-500">{t("notFound.description")}</p>
          <ButtonLink href={localizedPath(locale, "/")} className="mt-8">
            {t("notFound.back")}
          </ButtonLink>
        </Container>
      </main>
      <Footer />
    </>
  );
}
