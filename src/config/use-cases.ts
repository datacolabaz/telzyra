import type { NodeId } from "@/engine/nodes";
import { INTEGRATIONS } from "./integrations";

/**
 * Landing-page use cases. A use case is shown as live only when every integration it
 * depends on is "available"; otherwise it is labelled as a demonstration.
 */
export interface UseCase {
  key: "leads" | "orders" | "notifications" | "reporting" | "documents" | "sales";
  icon: "userPlus" | "cart" | "bell" | "chart" | "fileSearch" | "trendingUp";
  nodes: NodeId[];
  requiresIntegrations: string[];
}

export const USE_CASES: UseCase[] = [
  { key: "leads", icon: "userPlus", nodes: ["trigger.webhook", "logic.filter", "action.http_request"], requiresIntegrations: ["hubspot"] },
  { key: "orders", icon: "cart", nodes: ["trigger.webhook", "action.data_store", "action.send_email"], requiresIntegrations: ["shopify"] },
  { key: "notifications", icon: "bell", nodes: ["trigger.webhook", "logic.condition", "action.send_email"], requiresIntegrations: ["telegram"] },
  { key: "reporting", icon: "chart", nodes: ["trigger.schedule", "action.http_request", "action.send_email"], requiresIntegrations: ["google-sheets"] },
  { key: "documents", icon: "fileSearch", nodes: ["trigger.webhook", "ai.text_extract", "action.data_store"], requiresIntegrations: ["openai"] },
  { key: "sales", icon: "trendingUp", nodes: ["trigger.schedule", "logic.condition", "action.http_request"], requiresIntegrations: ["hubspot"] },
];

export function isUseCaseAvailable(useCase: UseCase): boolean {
  return useCase.requiresIntegrations.every(
    (id) => INTEGRATIONS.find((i) => i.id === id)?.status === "available",
  );
}
