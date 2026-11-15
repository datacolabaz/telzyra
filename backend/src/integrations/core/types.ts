import type { z } from "zod";
import type { HttpClient } from "./http.js";

/**
 * Connector SDK. A connector declares its identity, auth, actions, triggers, schemas,
 * error mapping, rate-limit behaviour and connection test. The runtime does everything else
 * (credential decryption + refresh, retries, circuit breaking, audit, workflow wiring).
 */
export type AuthSpec =
  | { type: "oauth2"; provider: string; scopes: string[] }
  | { type: "bot_token"; label: string; hint?: string }
  | { type: "api_key"; label: string; hint?: string }
  | { type: "none" };

/** Decrypted credential payload. Only ever exists in backend memory. */
export interface Credentials {
  accessToken?: string;
  refreshToken?: string;
  botToken?: string;
  apiKey?: string;
  /** Provider-specific non-secret extras (shop domain, team id, …) */
  [key: string]: unknown;
}

export interface ConnectionRef {
  id: string;
  workspaceId: string;
  externalAccountId: string | null;
}

export interface ConnectorContext {
  credentials: Credentials;
  connection: ConnectionRef;
  http: HttpClient;
  /** Stable key for this action invocation (execution + step), for idempotent provider APIs. */
  idempotencyKey?: string;
  publicApiUrl: string;
}

export interface ActionDefinition<I = any, O = any> {
  key: string;
  name: string;
  description: string;
  input: z.ZodType<I>;
  output?: z.ZodType<O>;
  /** OAuth scopes this action needs (subset of the connector's scopes). */
  scopes?: string[];
  run(ctx: ConnectorContext, input: I): Promise<O>;
}

/** A normalized event produced from a provider webhook or a polling cycle. */
export interface TriggerEvent {
  /** Trigger key this event belongs to (e.g. "new_message"). */
  trigger: string;
  /** Unique id for idempotency (provider event id / row number / message id). */
  id: string;
  data: Record<string, unknown>;
}

export interface PollResult {
  events: TriggerEvent[];
  cursor: unknown;
}

export interface TriggerDefinition<C = any> {
  key: string;
  name: string;
  description: string;
  /** webhook = pushed by the provider; polling = Telzyra checks on a schedule. */
  mode: "webhook" | "polling";
  config: z.ZodType<C>;
  /** Webhook mode: does an event match this workflow's trigger configuration? */
  matches?(event: TriggerEvent, config: C): boolean;
  /** Polling mode: fetch new items since `cursor`. First call (cursor undefined) only sets a baseline. */
  poll?(ctx: ConnectorContext, config: C, cursor: unknown): Promise<PollResult>;
  /** Polling mode: minimum minutes between polls (default POLL_INTERVAL_MINUTES). */
  pollIntervalMinutes?: number;
  /** Polling mode: only one active workflow per connection may consume this trigger (e.g. Telegram getUpdates). */
  exclusivePerConnection?: boolean;
  /** Example output, shown in the builder so users can map fields before the first real event. */
  sample?: Record<string, unknown>;
}

export interface RawWebhookRequest {
  headers: Record<string, string | undefined>;
  rawBody: Buffer;
  method: string;
  /** Full public URL the provider called (needed by HubSpot v3 signatures). */
  url: string;
  params: Record<string, string>;
  query: Record<string, string>;
}

export interface ParsedWebhook {
  /** Respond immediately with this body (URL verification challenges). */
  challenge?: unknown;
  dedupeKey?: string;
  eventType?: string;
  /** Provider account the event belongs to (Slack team_id, HubSpot portalId, Notion workspace_id). */
  accountId?: string;
  payload?: unknown;
  /** Events from one delivery (HubSpot batches several). */
  batch?: Array<{ dedupeKey: string; eventType: string; accountId?: string; payload: unknown }>;
}

export interface WebhookSpec {
  /**
   * per-connection: one URL per subscription, secret stored on the subscription (Telegram, Stripe, Shopify)
   * app: one URL for the whole Telzyra app, events routed by account id (Slack, Notion, HubSpot)
   */
  routing: "per-connection" | "app";
  /** Verify authenticity. `secret` = decrypted subscription secret for per-connection routing. */
  verify(req: RawWebhookRequest, secret?: string): boolean;
  parse(req: RawWebhookRequest): ParsedWebhook;
  /** Convert a stored payload into trigger events. */
  toEvents(payload: unknown, eventType: string | undefined): TriggerEvent[];
  /** Register the per-connection webhook at the provider. */
  subscribe?(ctx: ConnectorContext, opts: { url: string; secret: string; events: string[] }): Promise<{ externalId?: string; signingSecret?: string }>;
  unsubscribe?(ctx: ConnectorContext, externalId: string | null): Promise<void>;
}

export interface ConnectorDefinition {
  /** Destinations are user-supplied: use the SSRF-safe transport (connect-time DNS check, no proxy). */
  userSuppliedDestinations?: boolean;
  id: string;
  name: string;
  description: string;
  category: "communication" | "productivity" | "crm" | "commerce" | "payments" | "social" | "core";
  auth: AuthSpec;
  actions: Record<string, ActionDefinition>;
  triggers: Record<string, TriggerDefinition>;
  rateLimit: { note: string; requestsPerSecond?: number };
  /** Maps a non-2xx provider response to a normalized error. */
  mapError?: import("./http.js").HttpClientOptions["mapError"];
  isErrorBody?: import("./http.js").HttpClientOptions["isErrorBody"];
  /** Validates credentials and returns account identity for display. */
  test(ctx: ConnectorContext): Promise<{ accountId?: string; accountName: string }>;
  webhook?: WebhookSpec;
  /** Server-side configuration this connector needs (env var names); used for "not configured" status. */
  requiredEnv?: string[];
}
