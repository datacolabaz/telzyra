/**
 * Notion webhook verification token (Notion sends it once to /webhooks/notion; it is stored encrypted).
 *
 *   npm run notion:verification-token          → prints the token (production: paste it into Notion)
 *   npm run notion:verification-token -- --save
 *       local use: writes NOTION_WEBHOOK_VERIFICATION_TOKEN into backend/.env (in place, so the dev
 *       server restarts) and copies the token to the clipboard (macOS pbcopy) without printing it.
 *       Then paste it into the Notion connection's Webhooks → Verify field with Cmd+V.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { cipher, prisma } from "../src/db/client.js";
import { NOTION_VERIFICATION_AAD } from "../src/integrations/webhooks/webhook.service.js";

const save = process.argv.includes("--save");
const event = await prisma.webhookEvent.findFirst({ where: { provider: "notion", eventType: "verification" }, orderBy: { receivedAt: "desc" } });
if (!event) {
  console.error("No Notion verification request received yet. Add the webhook URL in Notion first.");
  process.exit(1);
}
const encrypted = (event.payload as { encryptedToken?: string }).encryptedToken;
if (!encrypted) {
  console.error("Token missing in the stored request.");
  process.exit(1);
}
const token = cipher.decrypt(encrypted, NOTION_VERIFICATION_AAD);

if (!save) {
  console.log(token);
} else {
  const envPath = join(import.meta.dirname, "../.env");
  const lines = readFileSync(envPath, "utf8").split("\n").filter((l) => !l.startsWith("NOTION_WEBHOOK_VERIFICATION_TOKEN="));
  if (lines.at(-1) === "") lines.pop();
  lines.push(`NOTION_WEBHOOK_VERIFICATION_TOKEN=${token}`, "");
  writeFileSync(envPath, lines.join("\n"), { mode: 0o600 });
  const now = new Date();
  utimesSync(join(import.meta.dirname, "../src/server.ts"), now, now); // restart the dev server's watcher
  let copied = false;
  try {
    execFileSync("pbcopy", { input: token });
    copied = true;
  } catch {
    // not macOS: the user can run without --save to see the token
  }
  console.log(`✓ NOTION_WEBHOOK_VERIFICATION_TOKEN saved to backend/.env (${token.length} chars).`);
  console.log(copied ? "✓ Token copied to the clipboard — paste it into Notion → Webhooks → Verify (Cmd+V)." : "Clipboard not available: run without --save to print it.");
}
await prisma.$disconnect();
