import type { Db } from "../db/client.js";

/**
 * Tenant isolation.
 *
 * `forWorkspace(prisma, workspaceId)` returns a Prisma client whose queries on tenant-owned
 * models are automatically restricted to one workspace:
 *  - reads, updates and deletes get `workspaceId` added to their `where`
 *  - creates get `workspaceId` forced into `data` (a different value is rejected)
 *
 * Feature code that handles tenant data must use this client. Looking a record up by id
 * alone can therefore never return another workspace's row.
 */
export const TENANT_MODELS = ["Membership", "Connection", "WebhookSubscription"] as const;
type TenantModel = (typeof TENANT_MODELS)[number];

const WHERE_OPS = new Set([
  "findUnique",
  "findUniqueOrThrow",
  "findFirst",
  "findFirstOrThrow",
  "findMany",
  "count",
  "aggregate",
  "groupBy",
  "update",
  "updateMany",
  "delete",
  "deleteMany",
  "upsert",
]);

export class TenantViolationError extends Error {
  constructor(model: string) {
    super(`Cross-tenant write rejected on ${model}`);
    this.name = "TenantViolationError";
  }
}

function forceWorkspace(data: unknown, workspaceId: string, model: string): Record<string, unknown> {
  const record = { ...(data as Record<string, unknown>) };
  if (record.workspaceId !== undefined && record.workspaceId !== workspaceId) {
    throw new TenantViolationError(model);
  }
  // Relation-style create (workspace: { connect }) is not allowed through the scoped client.
  if ("workspace" in record) throw new TenantViolationError(model);
  record.workspaceId = workspaceId;
  return record;
}

export function forWorkspace(db: Db, workspaceId: string) {
  return db.$extends({
    name: "tenant-scope",
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          if (!TENANT_MODELS.includes(model as TenantModel)) return query(args);
          const a = { ...(args as Record<string, unknown>) };

          if (WHERE_OPS.has(operation)) {
            a.where = { ...(a.where as Record<string, unknown> | undefined), workspaceId };
          }
          if (operation === "create") {
            a.data = forceWorkspace(a.data, workspaceId, model);
          }
          if (operation === "createMany" || operation === "createManyAndReturn") {
            const rows = Array.isArray(a.data) ? a.data : [a.data];
            a.data = rows.map((r) => forceWorkspace(r, workspaceId, model));
          }
          if (operation === "upsert") {
            a.create = forceWorkspace(a.create, workspaceId, model);
          }
          return query(a as typeof args);
        },
      },
    },
  });
}

export type ScopedDb = ReturnType<typeof forWorkspace>;
