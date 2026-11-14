import { z } from "zod";
import type { ConnectorDefinition } from "./types.js";

/**
 * Connector registry and discovery. Providers register here once; the catalogue API,
 * workflow builder, runtime and webhook router all resolve connectors through it.
 */
const connectors = new Map<string, ConnectorDefinition>();

export function registerConnector(def: ConnectorDefinition) {
  if (connectors.has(def.id)) throw new Error(`Connector already registered: ${def.id}`);
  connectors.set(def.id, def);
}

export function getConnector(id: string): ConnectorDefinition | undefined {
  return connectors.get(id);
}

export function listConnectors(): ConnectorDefinition[] {
  return [...connectors.values()];
}

export function isConfigured(def: ConnectorDefinition, env: Record<string, unknown> = process.env): boolean {
  return (def.requiredEnv ?? []).every((k) => typeof env[k] === "string" && (env[k] as string).length > 0);
}

function schemaOf(schema: z.ZodType) {
  try {
    return z.toJSONSchema(schema, { unrepresentable: "any" });
  } catch {
    return {};
  }
}

/** Public, secret-free description of a connector for the UI and workflow builder. */
export function describeConnector(def: ConnectorDefinition) {
  return {
    id: def.id,
    name: def.name,
    description: def.description,
    category: def.category,
    auth: def.auth.type === "oauth2" ? { type: "oauth2", scopes: def.auth.scopes } : def.auth,
    configured: isConfigured(def),
    rateLimit: def.rateLimit,
    actions: Object.values(def.actions).map((a) => ({
      key: a.key,
      name: a.name,
      description: a.description,
      inputSchema: schemaOf(a.input),
    })),
    triggers: Object.values(def.triggers).map((t) => ({
      key: t.key,
      name: t.name,
      description: t.description,
      mode: t.mode,
      pollIntervalMinutes: t.mode === "polling" ? (t.pollIntervalMinutes ?? Number(process.env.POLL_INTERVAL_MINUTES ?? 5)) : null,
      configSchema: schemaOf(t.config),
      sample: t.sample ?? null,
    })),
  };
}
