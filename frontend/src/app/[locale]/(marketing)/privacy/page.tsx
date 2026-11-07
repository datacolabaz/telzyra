import { buildMetadata } from "@/i18n/seo";
import { LegalDocument } from "@/components/marketing/LegalDocument";

export const generateMetadata = () => buildMetadata("privacy", "/privacy");

export default function PrivacyPage() {
  return <LegalDocument doc="privacy" />;
}
