/**
 * Connector registry. Only connectors with status "available" may be presented as
 * working features. Everything else is shown with an explicit "planned" label.
 *
 * Contract for GET /v1/connectors. App names are proper nouns and are not translated;
 * category names are localized via integrations.json (categories.<id>).
 */
export type IntegrationStatus = "available" | "beta" | "planned";

export type IntegrationCategory =
  | "productivity"
  | "communication"
  | "ai"
  | "marketing"
  | "ecommerce"
  | "databases"
  | "business";

export interface Integration {
  id: string;
  name: string;
  category: IntegrationCategory;
  status: IntegrationStatus;
}

export const INTEGRATION_CATEGORIES: IntegrationCategory[] = [
  "productivity",
  "communication",
  "ai",
  "marketing",
  "ecommerce",
  "databases",
  "business",
];

/**
 * Pre-launch roadmap. No third-party connector is live yet, so every entry is "planned".
 * Flip to "available" only once the connector ships in the Telzyra engine.
 */
export const INTEGRATIONS: Integration[] = [
  { id: "google-sheets", name: "Google Sheets", category: "productivity", status: "planned" },
  { id: "notion", name: "Notion", category: "productivity", status: "planned" },
  { id: "slack", name: "Slack", category: "communication", status: "planned" },
  { id: "telegram", name: "Telegram", category: "communication", status: "planned" },
  { id: "gmail", name: "Gmail", category: "communication", status: "planned" },
  { id: "openai", name: "OpenAI", category: "ai", status: "planned" },
  { id: "anthropic", name: "Anthropic", category: "ai", status: "planned" },
  { id: "mailchimp", name: "Mailchimp", category: "marketing", status: "planned" },
  { id: "shopify", name: "Shopify", category: "ecommerce", status: "planned" },
  { id: "woocommerce", name: "WooCommerce", category: "ecommerce", status: "planned" },
  { id: "postgresql", name: "PostgreSQL", category: "databases", status: "planned" },
  { id: "mysql", name: "MySQL", category: "databases", status: "planned" },
  { id: "hubspot", name: "HubSpot", category: "business", status: "planned" },
  { id: "stripe", name: "Stripe", category: "business", status: "planned" },
];
