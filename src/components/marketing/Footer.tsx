import Link from "next/link";
import { Logo } from "@/components/brand/Logo";
import { Badge, Container } from "@/components/ui/primitives";
import { localizedPath } from "@/i18n/routing";
import { getLocale, getTranslations } from "@/i18n/server";
import { SITE } from "@/config/site";
import { cacheLife } from "next/cache";

async function currentYear() {
  "use cache";
  cacheLife("days");
  return new Date().getFullYear();
}

export async function Footer() {
  const locale = await getLocale();
  const t = await getTranslations("common");
  const href = (p: string) => localizedPath(locale, p);
  const year = await currentYear();

  const linkClass = "text-sm text-ink-500 hover:text-ink-950";

  return (
    <footer className="border-t border-ink-100 bg-ink-50/60">
      <Container className="grid gap-12 py-16 md:grid-cols-[1.4fr_1fr_1fr_1fr]">
        <div className="max-w-sm">
          <Logo />
          <p className="mt-4 text-sm leading-relaxed text-ink-500">{t("footer.description")}</p>
        </div>

        <nav aria-labelledby="footer-product">
          <h2 id="footer-product" className="text-sm font-semibold text-ink-950">{t("footer.product")}</h2>
          <ul className="mt-4 space-y-3">
            <li><Link className={linkClass} href={href("/features")}>{t("footer.features")}</Link></li>
            <li><Link className={linkClass} href={href("/integrations")}>{t("footer.integrations")}</Link></li>
            <li><Link className={linkClass} href={href("/pricing")}>{t("footer.pricing")}</Link></li>
          </ul>
        </nav>

        <nav aria-labelledby="footer-company">
          <h2 id="footer-company" className="text-sm font-semibold text-ink-950">{t("footer.company")}</h2>
          <ul className="mt-4 space-y-3">
            <li className="flex items-center gap-2">
              <span className="text-sm text-ink-400">{t("footer.documentation")}</span>
              <Badge>{t("labels.comingSoon")}</Badge>
            </li>
            <li><a className={linkClass} href={`mailto:${SITE.contactEmail}`}>{t("footer.contact")}</a></li>
          </ul>
        </nav>

        <nav aria-labelledby="footer-legal">
          <h2 id="footer-legal" className="text-sm font-semibold text-ink-950">{t("footer.legal")}</h2>
          <ul className="mt-4 space-y-3">
            <li className="flex items-center gap-2">
              <span className="text-sm text-ink-400">{t("footer.privacy")}</span>
              <Badge>{t("labels.comingSoon")}</Badge>
            </li>
            <li className="flex items-center gap-2">
              <span className="text-sm text-ink-400">{t("footer.terms")}</span>
              <Badge>{t("labels.comingSoon")}</Badge>
            </li>
          </ul>
        </nav>
      </Container>
      <Container className="border-t border-ink-100 py-6">
        <p className="text-xs text-ink-400">{t("footer.rights", { year })}</p>
      </Container>
    </footer>
  );
}
