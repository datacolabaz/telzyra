import { defineConfig } from "@playwright/test";

/**
 * Browser E2E against the locally running stack:
 *   frontend  http://localhost:3000 (next start)
 *   backend   http://localhost:4000 (backend/test/e2e/server.ts: real API + pg-boss + Postgres, fake providers)
 *   control   http://localhost:4999 (fake-provider control API)
 * Start them with ./run-local-e2e.sh. CHROME_PATH selects a system Chrome instead of Playwright's.
 */
export default defineConfig({
  testDir: "./tests",
  timeout: 90_000,
  expect: { timeout: 15_000 },
  workers: 1,
  fullyParallel: false,
  reporter: [["list"], ["html", { open: "never", outputFolder: "report" }]],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3000",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    launchOptions: process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {},
  },
});
