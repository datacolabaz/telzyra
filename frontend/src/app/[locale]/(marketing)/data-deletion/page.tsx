import { SITE } from "@/config/site";
import { DeletionStatus } from "@/components/marketing/DeletionStatus";
import { LegalDocument } from "@/components/marketing/LegalDocument";
import { LOCALES } from "@/i18n/config";
import { buildMetadata } from "@/i18n/seo";
import { getLocale, getTranslations } from "@/i18n/server";

export const generateMetadata = () => buildMetadata("dataDeletion", "/data-deletion");

/** Data deletion instructions (Meta / Google requirement) and status check for a confirmation code. */
export default async function DataDeletionPage() {
  const locale = await getLocale();
  const t = await getTranslations("legal");
  return (
    <LegalDocument doc="dataDeletion">
      <DeletionStatus
        apiUrl={SITE.publicApiUrl}
        intl={LOCALES[locale].intl}
        labels={t.raw("dataDeletion.status") as Record<string, string>}
      />
    </LegalDocument>
  );
}
