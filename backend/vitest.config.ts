import { defineConfig } from "vitest/config";

// Tests run against a real Postgres. Set TEST_DATABASE_URL to a disposable database:
// the global setup DROPS and recreates its public schema.
const TEST_DB = process.env.TEST_DATABASE_URL ?? "postgresql://telzyra:telzyra@localhost:54329/telzyra_test";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    globalSetup: ["test/helpers/global-setup.ts"],
    fileParallelism: false,
    env: {
      NODE_ENV: "test",
      DATABASE_URL: TEST_DB,
      CREDENTIALS_KEY: "a".repeat(64),
      CREDENTIALS_KEY_VERSION: "2",
      CREDENTIALS_PREVIOUS_KEYS: `1:${"b".repeat(64)}`,
      CORS_ORIGINS: "http://localhost:3000,https://telzyra.com",
      TRUST_PROXY: "0",
      APP_URL: "http://localhost:3000",
      PUBLIC_API_URL: "https://api.test.telzyra.local",
      RUN_WORKERS: "false",
      TELEGRAM_TRIGGER_MODE: "webhook",
      GOOGLE_CLIENT_ID: "test-google-client",
      GOOGLE_CLIENT_SECRET: "test-google-secret",
      SLACK_CLIENT_ID: "test-slack-client",
      SLACK_CLIENT_SECRET: "test-slack-secret",
      SLACK_SIGNING_SECRET: "test-slack-signing",
      HUBSPOT_CLIENT_SECRET: "test-hubspot-secret",
      SHOPIFY_CLIENT_SECRET: "test-shopify-secret",
      NOTION_WEBHOOK_VERIFICATION_TOKEN: "test-notion-verification",
    },
  },
});
