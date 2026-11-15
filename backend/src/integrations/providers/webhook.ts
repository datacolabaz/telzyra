import { z } from "zod";
import type { ConnectorDefinition } from "../core/types.js";

/**
 * Core "Webhook" trigger: any service can start a workflow with an HTTPS request to the workflow's
 * secret URL (POST/PUT {PUBLIC_WEBHOOK_URL}/webhooks/hook/<token>). The URL is created when the
 * workflow is activated and can be rotated; see WorkflowHookService. No connection or account needed.
 */
export const WEBHOOK_CONNECTOR_ID = "webhook";

export const webhook: ConnectorDefinition = {
  id: WEBHOOK_CONNECTOR_ID,
  name: "Webhook",
  description: "Start a workflow when any service sends an HTTPS request to your unique URL.",
  category: "core",
  auth: { type: "none" },
  rateLimit: { note: "Inbound: 1 MB per request; requests are rate limited per sender IP." },
  async test() {
    return { accountName: "Webhook" };
  },
  actions: {},
  triggers: {
    catch_hook: {
      key: "catch_hook",
      name: "Catch webhook",
      description: "Starts when an HTTPS POST or PUT reaches this workflow's webhook URL. JSON, form and text bodies are supported.",
      mode: "webhook",
      config: z.object({}),
      sample: {
        method: "POST",
        body: { name: "Jane", email: "jane@example.com" },
        query: {},
        headers: { "content-type": "application/json", "user-agent": "curl/8.0" },
        received_at: "2026-11-15T12:00:00.000Z",
      },
    },
  },
};
