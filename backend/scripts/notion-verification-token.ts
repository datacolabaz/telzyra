/**
 * Prints the one-time Notion webhook verification token (stored encrypted when Notion
 * sends it to /webhooks/notion). Run on the server: `npm run notion:verification-token`.
 * Paste it into the Notion integration's Webhooks tab, then set NOTION_WEBHOOK_VERIFICATION_TOKEN.
 */
import { cipher, prisma } from "../src/db/client.js";
import { NOTION_VERIFICATION_AAD } from "../src/integrations/webhooks/webhook.service.js";

const event = await prisma.webhookEvent.findFirst({ where: { provider: "notion", eventType: "verification" }, orderBy: { receivedAt: "desc" } });
if (!event) {
  console.error("No Notion verification request received yet.");
  process.exit(1);
}
const encrypted = (event.payload as { encryptedToken?: string }).encryptedToken;
console.log(encrypted ? cipher.decrypt(encrypted, NOTION_VERIFICATION_AAD) : "Token missing");
await prisma.$disconnect();
