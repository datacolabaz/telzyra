import { expect, type Page } from "@playwright/test";

export const CONTROL = process.env.E2E_CONTROL_URL ?? "http://localhost:4999";
export const API = process.env.E2E_API_URL ?? "http://localhost:4000";
/** Fake bot token in the real format; accepted only by the E2E fake Telegram API. */
export const BOT_TOKEN = "7000001234:AAE2e-fake-token-for-tests-only_x";
export const SHEET_ID = "1E2eSheetLeads000000";

export async function control<T = Record<string, unknown>>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${CONTROL}${path}`, { method: body === undefined && path === "/state" ? "GET" : "POST", headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return (await res.json()) as T;
}

export async function registerUser(page: Page, label: string) {
  const email = `${label}.${Date.now()}@example.com`;
  await page.goto("/register");
  await page.getByLabel("Full name").fill(`E2E ${label}`);
  await page.getByLabel("Work email").fill(email);
  await page.getByLabel("Password").fill("correct-horse-battery-1");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
  return email;
}

/** Google consent cannot be automated (and must not be bypassed for real accounts). In E2E the
 * provider is fake: the consent page is replaced by an immediate redirect back with a one-time code. */
export async function fakeGoogleConsent(page: Page) {
  await page.route("https://accounts.google.com/**", async (route) => {
    const url = new URL(route.request().url());
    const { code } = await control<{ code: string }>("/google/code", {});
    const back = new URL(url.searchParams.get("redirect_uri")!);
    back.searchParams.set("state", url.searchParams.get("state")!);
    back.searchParams.set("code", code);
    back.searchParams.set("scope", url.searchParams.get("scope")!);
    await route.fulfill({ status: 302, headers: { Location: back.toString() } });
  });
}
