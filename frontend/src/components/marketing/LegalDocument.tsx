import { Container } from "@/components/ui/primitives";
import { LOCALES } from "@/i18n/config";
import { getLocale, getTranslations } from "@/i18n/server";

/** Date the current Privacy Policy and Terms were last changed. Update with every revision. */
export const LEGAL_UPDATED = "2026-11-07";

export interface LegalSection {
  h: string;
  p?: string[];
  list?: string[];
  after?: string;
}

/** Shared layout for Privacy Policy and Terms of Service: title, date, contents, sections. */
export async function LegalDocument({ doc }: { doc: "privacy" | "terms" }) {
  const locale = await getLocale();
  const t = await getTranslations("legal");
  const sections = t.raw(`${doc}.sections`) as LegalSection[];
  const updated = new Intl.DateTimeFormat(LOCALES[locale].intl, { dateStyle: "long", timeZone: "UTC" }).format(
    new Date(LEGAL_UPDATED),
  );
  const anchor = (i: number) => `section-${i + 1}`;

  return (
    <Container className="py-16 sm:py-20">
      <div className="grid gap-12 lg:grid-cols-[220px_1fr] lg:gap-16">
        <aside className="hidden lg:block">
          <nav aria-labelledby="toc-title" className="sticky top-24">
            <p id="toc-title" className="text-xs font-semibold uppercase tracking-wide text-ink-400">
              {t("contents")}
            </p>
            <ol className="mt-4 space-y-2.5 border-l border-ink-100">
              {sections.map((s, i) => (
                <li key={s.h}>
                  <a href={`#${anchor(i)}`} className="-ml-px block border-l border-transparent pl-4 text-sm text-ink-500 hover:border-ink-950 hover:text-ink-950">
                    {s.h}
                  </a>
                </li>
              ))}
            </ol>
          </nav>
        </aside>

        <article className="max-w-2xl">
          <h1 className="text-3xl font-semibold tracking-[-0.025em] text-ink-950 sm:text-4xl">{t(`${doc}.title`)}</h1>
          <p className="mt-3 text-sm text-ink-400">
            <time dateTime={LEGAL_UPDATED}>{t("updated", { date: updated })}</time>
          </p>
          <p className="mt-8 text-[17px] leading-relaxed text-ink-700">{t(`${doc}.intro`)}</p>

          {sections.map((s, i) => (
            <section key={s.h} id={anchor(i)} aria-labelledby={`${anchor(i)}-h`} className="mt-10 scroll-mt-24">
              <h2 id={`${anchor(i)}-h`} className="text-lg font-semibold text-ink-950">{s.h}</h2>
              {s.p?.map((para) => (
                <p key={para} className="mt-3 leading-relaxed text-ink-700">{para}</p>
              ))}
              {s.list && (
                <ul className="mt-3 list-disc space-y-2 pl-5 leading-relaxed text-ink-700 marker:text-ink-300">
                  {s.list.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              )}
              {s.after && <p className="mt-3 leading-relaxed text-ink-700">{s.after}</p>}
            </section>
          ))}
        </article>
      </div>
    </Container>
  );
}
