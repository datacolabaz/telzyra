import { expect, test, type Page } from "@playwright/test";
import { BOT_TOKEN, SHEET_ID, control, fakeGoogleConsent, registerUser } from "./helpers";

interface FakeState {
  telegram: { webhookUrl: string | null; pending: number; sent: Array<{ method: string; body: Record<string, unknown> }> };
  google: { sheets: Record<string, Record<string, unknown[][]>>; refreshCount: number };
}
const state = () => control<FakeState>("/state");

test.describe.configure({ mode: "serial" });

let page: Page;
test.beforeAll(async ({ browser }) => {
  await control("/reset", {});
  page = await browser.newPage();
  await registerUser(page, "owner");
});
test.afterAll(async () => page.close());

test("dashboard links to integrations; unauthenticated users are redirected", async ({ browser }) => {
  await page.getByRole("link", { name: "Open integrations" }).click();
  await expect(page).toHaveURL(/\/dashboard\/integrations$/);
  await expect(page.getByRole("heading", { name: "Integrations" })).toBeVisible();

  const anon = await browser.newPage();
  await anon.goto("/dashboard/integrations");
  await expect(anon).toHaveURL(/\/login/);
  await anon.close();
});

test("marketplace lists connectors from the API with configuration state", async () => {
  await page.goto("/dashboard/integrations");
  for (const id of ["telegram", "google-sheets", "slack", "notion", "gmail", "hubspot", "stripe", "shopify", "http"]) {
    await expect(page.getByTestId(`connector-${id}`)).toBeVisible();
  }
  await expect(page.getByTestId("connector-google-sheets").getByRole("button", { name: "Connect" })).toBeEnabled();
  await expect(page.getByTestId("connector-slack")).toContainText("Not configured on this server");
  await expect(page.getByTestId("connector-http")).toContainText("Built in");
  await page.getByPlaceholder("Search apps").fill("tele");
  await expect(page.getByTestId("connector-telegram")).toBeVisible();
  await expect(page.getByTestId("connector-slack")).toBeHidden();
  await page.getByPlaceholder("Search apps").fill("");
});

test("Telegram: rejects an invalid token, connects a valid one and never shows it again", async () => {
  await page.getByTestId("connector-telegram").getByRole("button", { name: "Connect" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Bot token").fill("123:not-a-real-token");
  await dialog.getByRole("button", { name: "Connect" }).click();
  await expect(dialog.getByRole("alert")).toBeVisible();

  await dialog.getByLabel("Bot token").fill(BOT_TOKEN);
  await dialog.getByRole("button", { name: "Connect" }).click();
  await expect(page.getByRole("status")).toContainText("Connected successfully.");
  const card = page.getByTestId("connection-telegram");
  await expect(card).toContainText("Active");
  await expect(card).toContainText("telzyra_e2e_bot");
  expect(await page.content()).not.toContain(BOT_TOKEN);
});

test("Test connection reports latency", async () => {
  await page.getByTestId("connection-telegram").getByRole("button", { name: "Test" }).click();
  await expect(page.getByRole("status")).toContainText(/Connection works \(\d+ ms\)/);
  await expect(page.getByTestId("connection-telegram")).not.toContainText("Never");
});

test("Google Sheets: OAuth round trip through the real callback", async () => {
  await fakeGoogleConsent(page);
  await page.getByRole("tab", { name: "All apps" }).click();
  await page.getByTestId("connector-google-sheets").getByRole("button", { name: "Connect" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Connect" }).click();
  await expect(page).toHaveURL(/\/dashboard\/integrations\?status=connected&connection=/);
  await expect(page.getByRole("status")).toContainText("Connected successfully.");
  await expect(page.getByTestId("connection-google-sheets")).toContainText("sheets.e2e@example.com");
  await page.screenshot({ path: "screenshots/1-connections.png", fullPage: true });
});

test("OAuth state cannot be replayed", async () => {
  const stale = await page.request.get(`${process.env.E2E_API_URL ?? "http://localhost:4000"}/v1/oauth/google/callback?state=forged&code=x`, { maxRedirects: 0 });
  expect(stale.status()).toBe(303);
  expect(stale.headers().location).toContain("reason=oauth.invalid_state");
});

let workflowUrl = "";
test("builds the Telegram → Google Sheets → Telegram workflow in the builder", async () => {
  await page.getByRole("navigation", { name: "App" }).getByRole("link", { name: "Workflows" }).click();
  await expect(page.getByRole("heading", { name: "Workflows" })).toBeVisible();
  await expect(page.getByText("No workflows yet.")).toBeVisible();
  await page.getByRole("button", { name: "New workflow" }).click();
  await page.getByLabel("Name").fill("Leads from Telegram");

  const trigger = page.getByTestId("trigger-card");
  await trigger.getByLabel("App").selectOption("telegram");
  await trigger.getByLabel("Event").selectOption("new_message");
  await expect(trigger).toContainText("Checked every 1 min."); // localhost → polling delivery
  // Only one Telegram connection exists, so it is pre-selected.
  await expect(trigger.getByLabel("Connection")).not.toHaveValue("");

  await page.getByRole("button", { name: "Add step" }).click();
  const save = page.getByTestId("step-card-0");
  await save.getByLabel("Step name").fill("save");
  await save.getByLabel("App").selectOption("google-sheets");
  await save.getByLabel("Action").selectOption("append_row");
  await expect(save.getByLabel("Connection")).not.toHaveValue("");
  await save.getByLabel(/^spreadsheet_id/).fill(SHEET_ID);
  await save.getByLabel(/^sheet/).fill("Leads");
  await save.getByLabel(/^values/).fill('["{{trigger.from.username}}", "{{trigger.text}}", "{{trigger.chat.id}}"]');

  await page.getByRole("button", { name: "Add step" }).click();
  const reply = page.getByTestId("step-card-1");
  await reply.getByLabel("Step name").fill("reply");
  await reply.getByLabel("App").selectOption("telegram");
  await reply.getByLabel("Action").selectOption("send_message");
  await expect(reply.getByLabel("Connection")).not.toHaveValue("");
  await reply.getByLabel(/^chat_id/).fill("{{trigger.chat.id}}");
  await reply.getByLabel(/^text/).fill("Saved to {{steps.save.updated_range}}");

  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();
  await expect(page.getByText("Draft", { exact: true })).toBeVisible();
  workflowUrl = page.url();
});

test("node test runs single steps with sample trigger data and earlier step output", async () => {
  const saveStep = page.getByTestId("step-card-0");
  await saveStep.getByRole("button", { name: "Test step" }).click();
  await expect(saveStep.getByText("Succeeded")).toBeVisible();
  await expect(saveStep.locator("pre")).toContainText("updated_range");
  let s = await state();
  // Telegram trigger sample: { from.username: "jane", text: "Hello!", chat.id: 123456789 }
  expect(s.google.sheets[SHEET_ID]!.Leads!.at(-1)).toEqual(["jane", "Hello!", 123456789]);

  const replyStep = page.getByTestId("step-card-1");
  await replyStep.getByRole("button", { name: "Test step" }).click();
  await expect(replyStep.getByText("Succeeded")).toBeVisible();
  s = await state();
  expect(s.telegram.sent.at(-1)?.body).toMatchObject({ chat_id: 123456789, text: "Saved to Leads!A2:C2" });
});

test("activates and runs end to end when a Telegram user writes to the bot", async () => {
  await page.getByRole("button", { name: "Activate" }).click();
  await expect(page.getByRole("button", { name: "Pause" })).toBeVisible();
  expect((await state()).telegram.webhookUrl).toBeNull(); // polling mode on localhost

  // First poll sets the baseline; then a user writes to the bot.
  await control("/poll-now", {});
  await expect.poll(async () => (await page.request.get("http://localhost:4000/health")).status()).toBe(200);
  await new Promise((r) => setTimeout(r, 1500));
  await control("/telegram/incoming", { chatId: 424242, text: "Hi, I want a demo", username: "jane_e2e" });
  // Poll interval for Telegram is 1 minute; the control API triggers it immediately (the test cannot wait for the cron).
  await expect
    .poll(async () => {
      await control("/poll-now", {});
      return (await state()).telegram.sent.filter((m) => m.method === "sendMessage" && m.body.chat_id === 424242).length;
    }, { timeout: 90_000, intervals: [2_000] })
    .toBeGreaterThan(0);

  const s = await state();
  expect(s.google.sheets[SHEET_ID]!.Leads!.at(-1)).toEqual(["jane_e2e", "Hi, I want a demo", 424242]);
  const sent = s.telegram.sent.find((m) => m.method === "sendMessage" && m.body.chat_id === 424242)!;
  expect(sent.body).toMatchObject({ chat_id: 424242, text: `Saved to Leads!A${s.google.sheets[SHEET_ID]!.Leads!.length}:C${s.google.sheets[SHEET_ID]!.Leads!.length}` });
});

test("execution history shows trigger data and step outputs", async () => {
  await page.reload();
  const runs = page.getByTestId("runs-card");
  await expect(runs.getByText("Succeeded").first()).toBeVisible();
  await expect(runs.getByText("Polling").first()).toBeVisible();
  await runs.locator("summary").first().click();
  await expect(runs).toContainText("Hi, I want a demo");
  await expect(runs).toContainText("save");
  await expect(runs).toContainText("updated_range");
  await expect(runs).toContainText("message_id");
  await page.screenshot({ path: "screenshots/2-workflow-run.png", fullPage: true });
});

test("manual test run with sample data records a failure clearly", async () => {
  // The sample trigger has no real chat; the fake Telegram accepts it, so make the run fail via sheet name.
  await page.getByTestId("step-card-0").getByLabel(/^sheet/).fill("Missing sheet");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Run test" }).click();
  const runs = page.getByTestId("runs-card");
  await expect(runs.getByText("Failed").first()).toBeVisible();
  await runs.locator("summary").first().click();
  await expect(runs).toContainText("VALIDATION");
  await expect(runs).toContainText("Skipped");
  await page.getByTestId("step-card-0").getByLabel(/^sheet/).fill("Leads");
  await page.getByRole("button", { name: "Save" }).click();
});

test("disconnecting Telegram pauses the workflow and blocks reuse", async () => {
  await page.goto("/dashboard/integrations");
  await page.getByRole("tab", { name: /My connections/ }).click();
  const card = page.getByTestId("connection-telegram");
  await expect(card).toContainText("Leads from Telegram");
  page.once("dialog", (d) => d.accept());
  await card.getByRole("button", { name: "Disconnect" }).click();
  await expect(card).toContainText("Disconnected");
  await expect(card.getByRole("button", { name: "Delete" })).toBeVisible();

  await page.goto("/dashboard/workflows");
  await expect(page.getByText("Paused", { exact: true })).toBeVisible();
});

test("the interface is localized (Azerbaijani)", async () => {
  await page.goto("/az/dashboard/integrations");
  await expect(page.getByRole("heading", { name: "İnteqrasiyalar" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Bütün tətbiqlər" })).toBeVisible();
  await page.goto("/az/dashboard/workflows");
  await expect(page.getByRole("heading", { name: "İş axınları" })).toBeVisible();
});
