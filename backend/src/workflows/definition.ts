import { z } from "zod";
import type { ScopedDb } from "../tenancy/scoped-db.js";
import { AppError } from "../lib/errors.js";
import { getConnector } from "../integrations/core/registry.js";

/**
 * Workflow definition v1: one trigger + an ordered list of action steps.
 * Step inputs may reference earlier data with templates: {{trigger.x}}, {{steps.<id>.y}}.
 */
export const MANUAL_TRIGGER = { connector: "manual", trigger: "manual" } as const;

export const workflowDefinitionSchema = z.object({
  trigger: z.object({
    connector: z.string().min(1).max(50),
    trigger: z.string().min(1).max(80),
    connectionId: z.string().uuid().nullish(),
    config: z.record(z.string(), z.unknown()).default({}),
  }),
  steps: z
    .array(
      z.object({
        id: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/, "Step id: lowercase letters, digits and _"),
        connector: z.string().min(1).max(50),
        action: z.string().min(1).max(80),
        connectionId: z.string().uuid().nullish(),
        input: z.record(z.string(), z.unknown()).default({}),
      }),
    )
    .min(1)
    .max(25),
});

export type WorkflowDefinition = z.infer<typeof workflowDefinitionSchema>;

/** Validates connectors, actions, trigger config and connection ownership. Returns a normalized definition. */
export async function validateDefinition(db: ScopedDb, raw: unknown): Promise<WorkflowDefinition> {
  const parsed = workflowDefinitionSchema.safeParse(raw);
  if (!parsed.success) throw new AppError(400, "workflow.invalid", { issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) });
  const def = parsed.data;
  const problems: Array<{ path: string; message: string }> = [];

  const checkConnection = async (path: string, connectorId: string, connectionId: string | null | undefined) => {
    const connector = getConnector(connectorId);
    if (!connector || connector.auth.type === "none") return;
    if (!connectionId) return problems.push({ path, message: "connection required" });
    const conn = await db.connection.findUnique({ where: { id: connectionId } }); // scoped: other workspaces are invisible
    if (!conn || conn.provider !== connectorId) problems.push({ path, message: "connection not found" });
  };

  if (!(def.trigger.connector === MANUAL_TRIGGER.connector && def.trigger.trigger === MANUAL_TRIGGER.trigger)) {
    const c = getConnector(def.trigger.connector);
    const t = c?.triggers[def.trigger.trigger];
    if (!t) problems.push({ path: "trigger", message: "unknown trigger" });
    else {
      const cfg = t.config.safeParse(def.trigger.config);
      if (!cfg.success) problems.push({ path: "trigger.config", message: cfg.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
      else def.trigger.config = cfg.data as Record<string, unknown>;
      await checkConnection("trigger.connectionId", def.trigger.connector, def.trigger.connectionId);
    }
  }

  const ids = new Set<string>();
  for (const [i, step] of def.steps.entries()) {
    if (ids.has(step.id)) problems.push({ path: `steps.${i}.id`, message: "duplicate step id" });
    ids.add(step.id);
    const c = getConnector(step.connector);
    if (!c?.actions[step.action]) problems.push({ path: `steps.${i}`, message: "unknown action" });
    await checkConnection(`steps.${i}.connectionId`, step.connector, step.connectionId);
  }
  if (problems.length) throw new AppError(400, "workflow.invalid", { issues: problems });
  return def;
}

export function triggerMode(def: WorkflowDefinition): "manual" | "webhook" | "polling" {
  if (def.trigger.connector === MANUAL_TRIGGER.connector) return "manual";
  return getConnector(def.trigger.connector)?.triggers[def.trigger.trigger]?.mode ?? "manual";
}
