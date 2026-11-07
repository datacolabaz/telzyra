/**
 * Plan catalogue: the source of truth served at GET /v1/plans.
 * The frontend keeps the same values in frontend/src/config/plans.ts only as a fallback
 * for when this API is unreachable (for example during the frontend build).
 * Prices are fixed per-currency price points (placeholders until billing is set up).
 */
export type Currency = "AZN" | "USD" | "TRY" | "RUB";
export type PlanId = "free" | "starter" | "pro" | "business";

export interface Plan {
  id: PlanId;
  monthlyPrice: Record<Currency, number>;
  highlighted?: boolean;
  limits: {
    operationsPerMonth: number;
    activeWorkflows: number | null;
    minScheduleMinutes: number;
    historyDays: number;
    members: number;
  };
  features: Array<"webhooks" | "conditionalLogic" | "aiSteps" | "prioritySupport" | "teamRoles">;
}

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
