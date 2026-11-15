import { registerConnector, listConnectors } from "../core/registry.js";
import { telegram } from "./telegram.js";
import { googleSheets } from "./google-sheets.js";
import { slack } from "./slack.js";
import { notion } from "./notion.js";
import { gmail } from "./gmail.js";
import { hubspot } from "./hubspot.js";
import { stripe } from "./stripe.js";
import { shopify } from "./shopify.js";
import { httpRequest } from "./http.js";
import { facebookPages } from "./facebook-pages.js";
import { instagram } from "./instagram.js";
import { webhook } from "./webhook.js";

/** Registers every built-in connector once. New providers are added here. */
export function registerBuiltInConnectors() {
  if (listConnectors().length > 0) return;
  for (const c of [telegram, googleSheets, slack, notion, gmail, hubspot, stripe, shopify, facebookPages, instagram, webhook, httpRequest]) registerConnector(c);
}
