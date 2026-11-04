/**
 * Node catalogue for the Telzyra Workflow Engine.
 *
 * `id` is a stable technical identifier stored in workflow definitions and used by
 * the engine. It is NEVER translated. Display labels live in messages/<locale>/nodes.json,
 * keyed by this exact id.
 */
export type NodeKind = "trigger" | "action" | "logic" | "ai";

export interface NodeDefinition {
  id: string;
  kind: NodeKind;
  icon: "webhook" | "clock" | "globe" | "split" | "sparkles" | "mail" | "database" | "filter";
}

export const NODE_CATALOGUE = [
  { id: "trigger.webhook", kind: "trigger", icon: "webhook" },
  { id: "trigger.schedule", kind: "trigger", icon: "clock" },
  { id: "action.http_request", kind: "action", icon: "globe" },
  { id: "action.send_email", kind: "action", icon: "mail" },
  { id: "action.data_store", kind: "action", icon: "database" },
  { id: "logic.condition", kind: "logic", icon: "split" },
  { id: "logic.filter", kind: "logic", icon: "filter" },
  { id: "ai.text_extract", kind: "ai", icon: "sparkles" },
] as const satisfies readonly NodeDefinition[];

export type NodeId = (typeof NODE_CATALOGUE)[number]["id"];

export function getNode(id: NodeId): NodeDefinition {
  const node = NODE_CATALOGUE.find((n) => n.id === id);
  if (!node) throw new Error(`Unknown node id: ${id}`);
  return node;
}
