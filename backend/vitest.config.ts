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
    },
  },
});
