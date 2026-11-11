/** Creating a workspace: the organization, its owner and sensible, safe defaults. */
import type { Agent, Integration, Organization, Policy, User } from "../contract/schemas";
import type { CreateWorkspaceInput } from "../contract/schemas";
import type { Queryable } from "../platform/db";
import { newId, toIso } from "../platform/ids";
import type { ExecutionMode } from "../tenancy/state";
import type { TenantStore } from "../tenancy/store";

const DAY = 86_400_000;

/** Secure by default (PRD §16): CI config is protected, sensitive actions need a human, deploys are prohibited. */
export function defaultPolicy(orgId: string): Policy {
  return {
    orgId,
    allowedProviders: ["claude_code"],
    requirePrApproval: false,
    protectedPaths: [".github/workflows/**"],
    networkAllowlist: ["registry.npmjs.org", "pypi.org", "files.pythonhosted.org", "github.com"],
    requiredChecks: ["ShipSafe / unit"],
    maxFixRetries: 3,
    sessionTimeoutMin: 45,
    approvalRules: [
      { action: "modify_protected_path", mode: "require_approval", approverRole: "admin" },
      { action: "access_secret", mode: "require_approval", approverRole: "owner" },
      { action: "run_migration", mode: "require_approval", approverRole: "admin" },
      { action: "network_egress", mode: "require_approval", approverRole: "admin" },
      { action: "budget_increase", mode: "require_approval", approverRole: "owner" },
      { action: "deploy_production", mode: "prohibited", approverRole: "owner" },
    ],
    suppressionMaxDays: 90,
    retentionDays: { logs: 30, artifacts: 30, audit: 365 },
  };
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 24);
}

export async function createWorkspace(
  q: Queryable,
  store: TenantStore,
  user: User,
  input: CreateWorkspaceInput,
  opts: { now: number; mode: ExecutionMode; isDemo: boolean; ip: string | null },
): Promise<Organization> {
  const id = newId("ws");
  const base = slugify(input.name) || id;
  const taken = await q.query(`SELECT 1 FROM organizations WHERE slug = $1`, [base]);
  const slug = taken.rows.length ? `${base.slice(0, 19)}-${id.slice(-4)}` : base;
  const org: Organization = {
    id,
    slug,
    name: input.name,
    kind: input.kind,
    plan: "free",
    billingCycle: "monthly",
    createdAt: toIso(opts.now),
    useCase: input.useCase,
    seatsPurchased: 1,
    budget: { monthlyLimitUsd: 25, hardCap: true, alertAtPct: [80, 100] },
    trialEndsAt: toIso(opts.now + 14 * DAY),
  };
  // Simulated execution ships with a ready-to-use agent so the product can be explored end to end.
  // Live execution starts with none: the agent appears when the customer connects their own provider key.
  const agents: Agent[] =
    opts.mode === "simulated"
      ? [
          {
            id: newId("agent"),
            orgId: id,
            provider: "claude_code",
            name: "Claude Code",
            model: "claude-sonnet",
            status: "active",
            maxConcurrent: 1,
            defaultTimeoutMin: 30,
            defaultBudgetUsd: 3,
          },
        ]
      : [];
  const integrations: Integration[] =
    opts.mode === "simulated"
      ? [
          {
            id: newId("int"),
            orgId: id,
            providerId: "claude_code",
            status: "connected",
            account: "ForgePilot-managed key (trial)",
            connectedAt: toIso(opts.now),
            scopes: ["agent:run"],
          },
        ]
      : [];
  await store.createOrganization(
    q,
    org,
    {
      policies: [defaultPolicy(id)],
      agents,
      integrations,
      auditLogs: [
        {
          id: newId("aud"),
          orgId: id,
          actor: { type: "person", id: user.id },
          action: "workspace.created",
          resource: `workspace:${id}`,
          at: toIso(opts.now),
          detail: input.name,
          ip: opts.ip,
        },
      ],
    },
    { isDemo: opts.isDemo },
  );
  await q.query(
    `INSERT INTO memberships (org_id, user_id, role, joined_at) VALUES ($1, $2, 'owner', $3)`,
    [id, user.id, org.createdAt],
  );
  return org;
}
