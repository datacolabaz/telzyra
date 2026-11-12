import type { Request } from "express";
import type { Db } from "../db/client.js";
import { logger } from "../lib/logger.js";
import { Prisma } from "../generated/prisma/client.js";

export type AuditAction =
  | "auth.registered"
  | "auth.login.success"
  | "auth.login.failed"
  | "auth.logout"
  | "connection.created"
  | "connection.refreshed"
  | "connection.tested"
  | "connection.revoked"
  | "connection.deleted"
  | "webhook.subscription.created"
  | "webhook.event.replayed";

export interface AuditEntry {
  action: AuditAction;
  workspaceId?: string | null;
  actorUserId?: string | null;
  targetType?: string;
  targetId?: string;
  metadata?: Record<string, unknown>;
}

/** Keys that must never be stored in audit metadata, even by mistake. */
const SECRET_KEY = /(password|token|secret|code|authorization|cookie|key)/i;

export function sanitizeMetadata(value: unknown, depth = 0): unknown {
  if (depth > 4 || value === null || value === undefined) return value ?? null;
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => sanitizeMetadata(v, depth + 1));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEY.test(k) ? "[REDACTED]" : sanitizeMetadata(v, depth + 1);
    }
    return out;
  }
  if (typeof value === "string" && value.length > 500) return `${value.slice(0, 500)}…`;
  return value;
}

export class AuditService {
  constructor(private readonly db: Db) {}

  /**
   * Writes an audit record. Audit failures are logged but never break the user's request.
   */
  async record(entry: AuditEntry, req?: Request): Promise<void> {
    try {
      await this.db.auditLog.create({
        data: {
          action: entry.action,
          workspaceId: entry.workspaceId ?? null,
          actorUserId: entry.actorUserId ?? null,
          targetType: entry.targetType ?? null,
          targetId: entry.targetId ?? null,
          ip: req?.ip ?? null,
          userAgent: req?.get("user-agent")?.slice(0, 300) ?? null,
          metadata: entry.metadata
            ? (sanitizeMetadata(entry.metadata) as Prisma.InputJsonValue)
            : Prisma.JsonNull,
        },
      });
    } catch (err) {
      logger.error({ err, action: entry.action }, "audit log write failed");
    }
  }
}
