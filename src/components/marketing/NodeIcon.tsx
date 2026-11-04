import { Clock, Database, Filter, Globe, Mail, Sparkles, Split, Webhook } from "lucide-react";
import type { NodeDefinition } from "@/engine/nodes";

const ICONS = {
  webhook: Webhook,
  clock: Clock,
  globe: Globe,
  split: Split,
  sparkles: Sparkles,
  mail: Mail,
  database: Database,
  filter: Filter,
} as const;

export const KIND_STYLES: Record<NodeDefinition["kind"], string> = {
  trigger: "bg-go-50 text-go-600 ring-go-600/15",
  action: "bg-signal-50 text-signal-600 ring-signal-600/15",
  logic: "bg-warn-50 text-warn-700 ring-warn-700/15",
  ai: "bg-brand-50 text-brand-600 ring-brand-100",
};

export function NodeIcon({ node, className = "size-4" }: { node: NodeDefinition; className?: string }) {
  const Icon = ICONS[node.icon];
  return <Icon className={className} aria-hidden />;
}
