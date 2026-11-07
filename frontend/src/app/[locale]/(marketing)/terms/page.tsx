import { buildMetadata } from "@/i18n/seo";
import { LegalDocument } from "@/components/marketing/LegalDocument";

export const generateMetadata = () => buildMetadata("terms", "/terms");

export default function TermsPage() {
  return <LegalDocument doc="terms" />;
}
