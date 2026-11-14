import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { RawWebhookRequest } from "../../src/integrations/core/types.js";
import { slack, slackSignature } from "../../src/integrations/providers/slack.js";
import { stripe, stripeSignatureHeader, verifyStripeSignature } from "../../src/integrations/providers/stripe.js";
import { hubspot, hubspotSignatureV3 } from "../../src/integrations/providers/hubspot.js";
import { shopify, shopifyWebhookHmac } from "../../src/integrations/providers/shopify.js";
import { notion, notionSignature } from "../../src/integrations/providers/notion.js";
import { telegram } from "../../src/integrations/providers/telegram.js";
import { buildMime, gmail } from "../../src/integrations/providers/gmail.js";
import { shopifyQueryHmac } from "../../src/integrations/oauth/providers.js";

const req = (body: string, headers: Record<string, string>, extra: Partial<RawWebhookRequest> = {}): RawWebhookRequest => ({ headers, rawBody: Buffer.from(body), method: "POST", url: "https://api.test.telzyra.local/webhooks/x", params: {}, query: {}, ...extra });
const now = () => String(Math.floor(Date.now() / 1000));

describe("webhook signature verification", () => {
  it("Slack: v0 HMAC within 5 minutes", () => {
    const body = JSON.stringify({ type: "event_callback", event_id: "Ev1" });
    const ts = now();
    expect(slack.webhook!.verify(req(body, { "x-slack-request-timestamp": ts, "x-slack-signature": slackSignature("test-slack-signing", ts, body) }))).toBe(true);
    expect(slack.webhook!.verify(req(body, { "x-slack-request-timestamp": ts, "x-slack-signature": slackSignature("wrong", ts, body) }))).toBe(false);
    const old = String(Number(ts) - 600);
    expect(slack.webhook!.verify(req(body, { "x-slack-request-timestamp": old, "x-slack-signature": slackSignature("test-slack-signing", old, body) }))).toBe(false);
  });

  it("Stripe: t/v1 header with tolerance", () => {
    const body = '{"id":"evt_1"}';
    expect(verifyStripeSignature(stripeSignatureHeader("whsec_x", body), body, "whsec_x")).toBe(true);
    expect(verifyStripeSignature(stripeSignatureHeader("whsec_x", body), body + " ", "whsec_x")).toBe(false);
    expect(verifyStripeSignature(stripeSignatureHeader("whsec_x", body, Math.floor(Date.now() / 1000) - 1000), body, "whsec_x")).toBe(false);
    expect(stripe.webhook!.verify(req(body, { "stripe-signature": stripeSignatureHeader("whsec_x", body) }), undefined)).toBe(false);
  });

  it("HubSpot: v3 signature over method + uri + body + timestamp", () => {
    const body = "[]";
    const ts = String(Date.now());
    const url = "https://api.test.telzyra.local/webhooks/hubspot";
    const sig = hubspotSignatureV3("test-hubspot-secret", "POST", url, body, ts);
    expect(hubspot.webhook!.verify(req(body, { "x-hubspot-signature-v3": sig, "x-hubspot-request-timestamp": ts }, { url }))).toBe(true);
    expect(hubspot.webhook!.verify(req(body, { "x-hubspot-signature-v3": sig, "x-hubspot-request-timestamp": ts }, { url: url + "?x=1" }))).toBe(false);
  });

  it("Shopify: base64 HMAC of the raw body", () => {
    const body = '{"id":1}';
    expect(shopify.webhook!.verify(req(body, { "x-shopify-hmac-sha256": shopifyWebhookHmac("test-shopify-secret", body) }))).toBe(true);
    expect(shopify.webhook!.verify(req(body, { "x-shopify-hmac-sha256": shopifyWebhookHmac("other", body) }))).toBe(false);
  });

  it("Shopify OAuth callback HMAC", () => {
    const q = { code: "c", shop: "a.myshopify.com", state: "s", timestamp: "1" };
    const hmac = shopifyQueryHmac(q, "sec");
    const expected = createHmac("sha256", "sec").update("code=c&shop=a.myshopify.com&state=s&timestamp=1").digest("hex");
    expect(hmac).toBe(expected);
  });

  it("Notion: sha256= signature; verification request passes once", () => {
    const body = JSON.stringify({ id: "e1", type: "page.created", workspace_id: "w" });
    expect(notion.webhook!.verify(req(body, { "x-notion-signature": notionSignature("test-notion-verification", body) }))).toBe(true);
    expect(notion.webhook!.verify(req(body, { "x-notion-signature": notionSignature("x", body) }))).toBe(false);
    expect(notion.webhook!.verify(req(JSON.stringify({ verification_token: "secret_abc" }), {}))).toBe(true);
  });

  it("Telegram: secret token header", () => {
    expect(telegram.webhook!.verify(req("{}", { "x-telegram-bot-api-secret-token": "s3cret" }), "s3cret")).toBe(true);
    expect(telegram.webhook!.verify(req("{}", { "x-telegram-bot-api-secret-token": "nope" }), "s3cret")).toBe(false);
    expect(telegram.webhook!.verify(req("{}", {}), "s3cret")).toBe(false);
  });
});

describe("Gmail MIME builder", () => {
  it("rejects header injection in the subject", () => {
    const r = gmail.actions.send_email!.input.safeParse({ to: "a@example.com", subject: "Hi\r\nBcc: evil@example.com", text: "x" });
    expect(r.success).toBe(false);
  });
  it("encodes non-ASCII subjects (RFC 2047) and base64 bodies", () => {
    const mime = buildMime({ to: ["a@example.com", "b@example.com"], subject: "Salam, dünya", text: "Mətn" });
    expect(mime).toContain("To: a@example.com, b@example.com");
    expect(mime).toContain(`Subject: =?UTF-8?B?${Buffer.from("Salam, dünya").toString("base64")}?=`);
    expect(mime).toContain(Buffer.from("Mətn").toString("base64"));
  });
});
