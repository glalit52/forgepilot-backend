/**
 * Plan catalogue (PRD §18). Prices are hypotheses from the PRD; quotas are
 * illustrative and must be validated against real unit costs before launch.
 * Single source for the pricing page, billing page and entitlement checks.
 */
import type { Meter, Plan, PlanId } from "../schemas";

export const PLANS: Plan[] = [
  {
    id: "free",
    name: "Free",
    priceMonthlyUsd: 0,
    priceAnnualMonthlyUsd: 0,
    highlighted: false,
    tagline: "Kick the tyres on one repository.",
    audience: "Individual evaluator",
    limits: {
      projects: 1,
      repositories: 1,
      seats: 1,
      agentMinutes: 60,
      browserMinutes: 200,
      testRuns: 50,
      historyDays: 7,
      concurrentSessions: 1,
    },
    features: [
      "ShipSafe PR checks on 1 repository",
      "Weekly CodeKeeper scan",
      "1 concurrent agent session",
      "7-day history",
    ],
  },
  {
    id: "developer",
    name: "Developer",
    priceMonthlyUsd: 29,
    priceAnnualMonthlyUsd: 24,
    highlighted: false,
    tagline: "For the AI-native solo developer.",
    audience: "Individual developer",
    limits: {
      projects: 3,
      repositories: 5,
      seats: 1,
      agentMinutes: 600,
      browserMinutes: 2_000,
      testRuns: 500,
      historyDays: 30,
      concurrentSessions: 2,
    },
    features: [
      "Core ShipSafe verification",
      "Basic CodeKeeper maintenance",
      "DevPilot sessions with Claude Code or Codex",
      "30-day history",
    ],
  },
  {
    id: "pro",
    name: "Pro",
    priceMonthlyUsd: 79,
    priceAnnualMonthlyUsd: 66,
    highlighted: false,
    tagline: "Power users running agents in parallel.",
    audience: "Power user / indie team",
    limits: {
      projects: 10,
      repositories: 20,
      seats: 3,
      agentMinutes: 2_000,
      browserMinutes: 6_000,
      testRuns: 2_000,
      historyDays: 90,
      concurrentSessions: 4,
    },
    features: [
      "Everything in Developer",
      "Parallel agent sessions",
      "Visual comparisons & advanced reports",
      "Slack, Linear & Jira integrations",
    ],
  },
  {
    id: "team",
    name: "Team",
    priceMonthlyUsd: 199,
    priceAnnualMonthlyUsd: 166,
    highlighted: true,
    tagline: "One workspace for the whole engineering team.",
    audience: "Small engineering team",
    limits: {
      projects: null,
      repositories: 50,
      seats: 10,
      agentMinutes: 6_000,
      browserMinutes: 20_000,
      testRuns: 8_000,
      historyDays: 180,
      concurrentSessions: 8,
    },
    features: [
      "Everything in Pro",
      "Roles, approvals & policies",
      "Shared projects and budgets",
      "Approval centre & audit log",
    ],
  },
  {
    id: "business",
    name: "Business",
    priceMonthlyUsd: 499,
    priceAnnualMonthlyUsd: 416,
    highlighted: false,
    tagline: "Governance for growing software companies and agencies.",
    audience: "Growing company / agency",
    limits: {
      projects: null,
      repositories: 200,
      seats: 30,
      agentMinutes: 20_000,
      browserMinutes: 60_000,
      testRuns: 30_000,
      historyDays: 365,
      concurrentSessions: 20,
    },
    features: [
      "Everything in Team",
      "Client workspaces for agencies",
      "Advanced audit export & retention",
      "Priority support",
    ],
  },
  {
    id: "enterprise",
    name: "Enterprise",
    priceMonthlyUsd: null,
    priceAnnualMonthlyUsd: null,
    highlighted: false,
    tagline: "Security, procurement and scale.",
    audience: "Larger organisations",
    limits: {
      projects: null,
      repositories: null,
      seats: null,
      agentMinutes: null,
      browserMinutes: null,
      testRuns: null,
      historyDays: null,
      concurrentSessions: null,
    },
    features: [
      "SSO / SAML & SCIM",
      "Custom retention & data residency",
      "Dedicated execution capacity",
      "SLA & security reviews",
    ],
  },
];

/** Overage price per unit beyond plan quota. Metered transparently (PRD §18.1). */
export const METER_INFO: Record<
  Meter,
  { label: string; unit: string; overageUsd: number; quotaKey?: keyof Plan["limits"] }
> = {
  agent_minutes: {
    label: "Agent runtime",
    unit: "min",
    overageUsd: 0.12,
    quotaKey: "agentMinutes",
  },
  browser_minutes: {
    label: "Browser test minutes",
    unit: "min",
    overageUsd: 0.02,
    quotaKey: "browserMinutes",
  },
  test_runs: { label: "Verification runs", unit: "runs", overageUsd: 0, quotaKey: "testRuns" },
  scan_runs: { label: "Maintenance scans", unit: "scans", overageUsd: 0 },
  storage_gb: { label: "Artifact storage", unit: "GB", overageUsd: 0.1 },
};

export function planById(id: PlanId): Plan {
  return PLANS.find((p) => p.id === id) ?? PLANS[0];
}

export const PLAN_ORDER: PlanId[] = ["free", "developer", "pro", "team", "business", "enterprise"];

export function isUpgrade(from: PlanId, to: PlanId) {
  return PLAN_ORDER.indexOf(to) > PLAN_ORDER.indexOf(from);
}

/** Feature gates by plan (keeps the UI honest about what a plan includes). */
export const FEATURE_MIN_PLAN = {
  approvals: "team",
  policies: "team",
  auditLog: "team",
  auditExport: "business",
  clientWorkspaces: "business",
  sso: "enterprise",
  parallelSessions: "pro",
  integrationsAdvanced: "pro",
} as const satisfies Record<string, PlanId>;

export function hasFeature(plan: PlanId, feature: keyof typeof FEATURE_MIN_PLAN) {
  return PLAN_ORDER.indexOf(plan) >= PLAN_ORDER.indexOf(FEATURE_MIN_PLAN[feature]);
}
