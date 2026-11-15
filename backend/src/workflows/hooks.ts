import { webhookBaseUrl } from "../config/env.js";
import type { Db } from "../db/client.js";
import type { RawWebhookRequest } from "../integrations/core/types.js";
import { logger } from "../lib/logger.js";
import type { CredentialCipher } from "../security/crypto.js";
import { randomToken, sha256 } from "../security/crypto.js";
import type { WorkflowEngine } from "./engine.js";

/**
 * Inbound "Webhook" trigger (connector "webhook", trigger "catch_hook").
 *
 *  - Each workflow gets its own secret URL: {webhook base}/webhooks/hook/<token> (192-bit token).
 *    The token is the credential, like Zapier/Make catch hooks; it never appears in logs
 *    (safeLogUrl masks it) and only its SHA-256 is used for lookup. An encrypted copy lets the
 *    owner see the URL again; rotating it invalidates the old URL immediately.
 *  - Only ACTIVE workflows accept requests; anything else gets the same 404 as an unknown token.
 *  - Body: JSON, form-urlencoded or text (max 1 MB, enforced by the router). Sensitive headers
 *    (authorization, cookies, proxy/CDN headers) are dropped before the data reaches the workflow.
 *  - Idempotency-Key (or X-Request-Id) header → at most one execution per key.
 */

const AAD = (workflowId: string) => `workflow-hook:${workflowId}`;
const DROP_HEADER = /^(authorization|proxy-authorization|cookie|set-cookie|x-forwarded-.*|x-real-ip|forwarded|cf-.*|cdn-.*|true-client-ip|x-telzyra-.*|host|connection|content-length|accept-encoding)$/i;

export type HookResult = { status: number; body: Record<string, unknown> };

export class WorkflowHookService {
  constructor(
    private readonly db: Db,
    private readonly cipher: CredentialCipher,
    private readonly engine: WorkflowEngine,
  ) {}

  static urlFor(token: string) {
    return `${webhookBaseUrl()}/webhooks/hook/${token}`;
  }

  /** Creates the workflow's URL if it has none yet. Idempotent. */
  async ensure(workspaceId: string, workflowId: string) {
    const existing = await this.db.workflowHook.findUnique({ where: { workflowId } });
    if (existing) return;
    const token = randomToken(24);
    await this.db.workflowHook.create({ data: { workflowId, workspaceId, tokenHash: sha256(token), tokenEnc: this.cipher.encrypt(token, AAD(workflowId)) } });
  }

  /** The URL to show the owner, or null if the workflow has never been activated with a webhook trigger. */
  async url(workspaceId: string, workflowId: string): Promise<string | null> {
    const hook = await this.db.workflowHook.findFirst({ where: { workflowId, workspaceId } });
    return hook ? WorkflowHookService.urlFor(this.cipher.decrypt(hook.tokenEnc, AAD(workflowId))) : null;
  }

  /** Replaces the token; the previous URL stops working at once. */
  async rotate(workspaceId: string, workflowId: string): Promise<string> {
    const token = randomToken(24);
    const data = { tokenHash: sha256(token), tokenEnc: this.cipher.encrypt(token, AAD(workflowId)) };
    const existing = await this.db.workflowHook.findFirst({ where: { workflowId, workspaceId } });
    if (existing) await this.db.workflowHook.update({ where: { id: existing.id }, data: { ...data, rotatedAt: new Date() } });
    else await this.db.workflowHook.create({ data: { workflowId, workspaceId, ...data } });
    return WorkflowHookService.urlFor(token);
  }

  async receive(token: string, raw: RawWebhookRequest): Promise<HookResult> {
    const notFound: HookResult = { status: 404, body: { code: "not_found" } };
    if (!/^[A-Za-z0-9_-]{16,100}$/.test(token)) return notFound;
    const hook = await this.db.workflowHook.findUnique({ where: { tokenHash: sha256(token) }, include: { workflow: { select: { id: true, workspaceId: true, status: true, triggerConnector: true } } } });
    if (!hook || hook.workflow.status !== "ACTIVE" || hook.workflow.triggerConnector !== "webhook") return notFound;

    let body: unknown;
    try {
      body = parseBody(raw);
    } catch {
      return { status: 400, body: { code: "webhook.invalid_payload" } };
    }
    const headers = Object.fromEntries(Object.entries(raw.headers).filter(([k, v]) => v !== undefined && !DROP_HEADER.test(k))) as Record<string, string>;
    const key = (raw.headers["idempotency-key"] ?? raw.headers["x-request-id"] ?? "").trim();
    const triggerData = { method: raw.method, body, query: raw.query, headers, received_at: new Date().toISOString() };

    const exec = await this.engine.createExecution({
      workspaceId: hook.workflow.workspaceId,
      workflowId: hook.workflow.id,
      source: "webhook",
      triggerData,
      ...(key && key.length <= 200 ? { triggerEventId: `hook:${sha256(key)}` } : {}),
    });
    if (!exec) return { status: 200, body: { status: "duplicate" } };
    logger.info({ workflowId: hook.workflow.id, executionId: exec.id }, "webhook trigger accepted");
    return { status: 202, body: { status: "accepted", execution_id: exec.id } };
  }
}

function parseBody(raw: RawWebhookRequest): unknown {
  const text = raw.rawBody.toString("utf8");
  if (!text.trim()) return {};
  const type = (raw.headers["content-type"] ?? "").toLowerCase();
  if (type.includes("application/json") || type.includes("+json")) return JSON.parse(text);
  if (type.includes("application/x-www-form-urlencoded")) return Object.fromEntries(new URLSearchParams(text));
  // Unknown type: keep JSON if it is JSON, otherwise pass the text through.
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
