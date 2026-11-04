import { cacheLife } from "next/cache";
import type { Currency } from "./currency";

/**
 * Subscription plans.
 *
 * Contract for GET /v1/plans on the Telzyra Platform API. Limits are configured in the
 * backend; the values below are PLACEHOLDER DEFAULTS used only until the API is live.
 * Plan names and descriptions are localized via messages/<locale>/pricing.json (plans.<id>).
 */
export type PlanId = "free" | "starter" | "pro" | "business";

export interface PlanLimits {
  /** Node executions per month. */
  operationsPerMonth: number;
  /** Simultaneously active workflows. null = unlimited. */
  activeWorkflows: number | null;
  /** Minimum interval between scheduled runs, in minutes. */
  minScheduleMinutes: number;
  /** Execution history retention, in days. */
  historyDays: number;
  /** Workspace members. */
  members: number;
}

export interface Plan {
  id: PlanId;
  /**
   * Monthly price per display currency. Fixed price points, not live conversions.
   * PLACEHOLDERS derived from USD (AZN 1.70 peg; ~48 TRY, ~80 RUB per USD, Nov 2026),
   * rounded to clean local price points. Final values come from the billing backend.
   */
  monthlyPrice: Record<Currency, number>;
  highlighted?: boolean;
  limits: PlanLimits;
  /** Feature flags rendered from pricing.json features.<key>. */
  features: Array<"webhooks" | "conditionalLogic" | "aiSteps" | "prioritySupport" | "teamRoles">;
}

/** Yearly price = monthlyPrice × yearlyMonths (10 = "2 months free"). */
export const BILLING = { yearlyMonths: 10 } as const;

export const PLANS: Plan[] = [
  {
    id: "free",
    monthlyPrice: { AZN: 0, USD: 0, TRY: 0, RUB: 0 },
    limits: { operationsPerMonth: 1000, activeWorkflows: 2, minScheduleMinutes: 15, historyDays: 7, members: 1 },
    features: ["webhooks"],
  },
  {
    id: "starter",
    monthlyPrice: { AZN: 15, USD: 9, TRY: 449, RUB: 749 },
    limits: { operationsPerMonth: 10000, activeWorkflows: 10, minScheduleMinutes: 5, historyDays: 30, members: 1 },
    features: ["webhooks", "conditionalLogic"],
  },
  {
    id: "pro",
    monthlyPrice: { AZN: 32, USD: 19, TRY: 949, RUB: 1549 },
    highlighted: true,
    limits: { operationsPerMonth: 40000, activeWorkflows: null, minScheduleMinutes: 1, historyDays: 30, members: 3 },
    features: ["webhooks", "conditionalLogic", "aiSteps"],
  },
  {
    id: "business",
    monthlyPrice: { AZN: 83, USD: 49, TRY: 2449, RUB: 3990 },
    limits: { operationsPerMonth: 150000, activeWorkflows: null, minScheduleMinutes: 1, historyDays: 90, members: 10 },
    features: ["webhooks", "conditionalLogic", "aiSteps", "teamRoles", "prioritySupport"],
  },
];

/** Fetch plans from the API when configured; fall back to defaults. */
export async function getPlans(): Promise<Plan[]> {
  "use cache";
  cacheLife("hours");
  const api = process.env.TELZYRA_API_URL;
  if (!api) return PLANS;
  try {
    const res = await fetch(`${api}/v1/plans`);
    if (!res.ok) return PLANS;
    return (await res.json()) as Plan[];
  } catch {
    return PLANS;
  }
}
