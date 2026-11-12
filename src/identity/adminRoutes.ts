/**
 * Back-office for ForgePilot staff ("super admin"): sits above every workspace.
 * Staff can find workspaces and users, see operational summaries, suspend or
 * restore a workspace, set a plan (enterprise deals, goodwill) and retry failed
 * jobs. They cannot read a workspace's code, logs or credentials from here, and
 * everything they do is written to `staff_audit` and to the workspace's own
 * audit log so customers can see it.
 */
import { z } from "zod";
import * as S from "../contract/schemas";
import { planById } from "../contract/domain/plans";
import { connectorStatus } from "../connectors/status";
import { audit } from "../domain/loop";
import { monthToDateSpend } from "../domain/views";
import { HttpError } from "../platform/errors";
import type { GlobalCtx, GlobalRouteDef } from "./routes";

function body<T>(schema: z.ZodType<T>, b: unknown): T {
  const r = schema.safeParse(b ?? {});
  if (!r.success) throw new HttpError(422, "Validation failed", z.flattenError(r.error));
  return r.data;
}

async function record(ctx: GlobalCtx, action: string, target: string, detail = "") {
  await ctx.app.db.query(
    `INSERT INTO staff_audit (user_id, action, target, detail, ip) VALUES ($1, $2, $3, $4, $5)`,
    [ctx.user!.id, action, target, detail.slice(0, 1000), ctx.ip],
  );
}

const STAFF_ACTOR = { type: "system" as const, id: "forgepilot_staff" };
const limit = (ctx: GlobalCtx) =>
  Math.min(200, Math.max(1, Number(ctx.query.get("limit") ?? 50) || 50));
const iso = (d: Date | string | null) => (d ? new Date(d).toISOString() : null);

const WorkspaceRowSchema = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  plan: S.PlanIdSchema,
  kind: S.WorkspaceKindSchema,
  members: z.number(),
  createdAt: z.string(),
  demo: z.boolean(),
  suspendedAt: z.string().nullable(),
  suspendedReason: z.string().nullable(),
  hasBillingAccount: z.boolean(),
});
const ReasonSchema = z.object({
  reason: z.string().trim().min(5, "Say why (at least 5 characters)").max(500),
});
const SetPlanSchema = ReasonSchema.extend({
  plan: S.PlanIdSchema,
  billingCycle: z.enum(["monthly", "annual"]).optional(),
});

interface OrgRow {
  id: string;
  slug: string;
  data: S.Organization;
  members: number;
  created_at: Date;
  is_demo: boolean;
  suspended_at: Date | null;
  suspended_reason: string | null;
  stripe_customer_id: string | null;
}
const ORG_SELECT = `SELECT o.id, o.slug, o.data, o.created_at, o.is_demo, o.suspended_at, o.suspended_reason, o.stripe_customer_id,
  (SELECT count(*)::int FROM memberships m WHERE m.org_id = o.id AND m.removed_at IS NULL) AS members
  FROM organizations o`;
const toRow = (r: OrgRow): z.infer<typeof WorkspaceRowSchema> => ({
  id: r.id,
  slug: r.slug,
  name: r.data.name,
  plan: r.data.plan,
  kind: r.data.kind,
  members: Number(r.members),
  createdAt: iso(r.created_at)!,
  demo: r.is_demo,
  suspendedAt: iso(r.suspended_at),
  suspendedReason: r.suspended_reason,
  hasBillingAccount: !!r.stripe_customer_id,
});

async function workspaceRow(ctx: GlobalCtx, id: string) {
  const { rows } = await ctx.app.db.query<OrgRow>(`${ORG_SELECT} WHERE o.id = $1`, [id]);
  if (!rows[0]) throw new HttpError(404, "Workspace not found");
  return toRow(rows[0]);
}

export const adminRoutes: GlobalRouteDef[] = [
  {
    method: "GET",
    path: "/admin/overview",
    auth: "staff",
    summary: "Platform totals: workspaces by plan, users, queue health and connector status.",
    response: z.object({
      workspaces: z.number(),
      suspended: z.number(),
      users: z.number(),
      byPlan: z.record(z.string(), z.number()),
      jobs: z.object({ queued: z.number(), running: z.number(), failed: z.number() }),
      connectors: z.array(
        z.object({
          id: z.string(),
          name: z.string(),
          state: z.enum(["ready", "partial", "off"]),
          missing: z.array(z.string()),
        }),
      ),
      executionMode: z.enum(["simulated", "live"]),
    }),
    handler: async (ctx) => {
      const db = ctx.app.db;
      const orgs = await db.query<{ plan: string; n: number; suspended: number }>(
        `SELECT data->>'plan' AS plan, count(*)::int AS n, count(suspended_at)::int AS suspended FROM organizations WHERE NOT is_demo GROUP BY 1`,
      );
      const users = await db.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM users WHERE NOT is_demo`,
      );
      const jobs = await db.query<{ status: string; n: number }>(
        `SELECT status, count(*)::int AS n FROM jobs WHERE status <> 'done' GROUP BY 1`,
      );
      const job = (s: string) => Number(jobs.rows.find((r) => r.status === s)?.n ?? 0);
      return {
        workspaces: orgs.rows.reduce((s, r) => s + Number(r.n), 0),
        suspended: orgs.rows.reduce((s, r) => s + Number(r.suspended), 0),
        users: Number(users.rows[0]?.n ?? 0),
        byPlan: Object.fromEntries(orgs.rows.map((r) => [r.plan, Number(r.n)])),
        jobs: { queued: job("queued"), running: job("running"), failed: job("failed") },
        connectors: connectorStatus(ctx.app.config).map(({ id, name, state, missing }) => ({
          id,
          name,
          state,
          missing,
        })),
        executionMode: ctx.app.config.execution.mode,
      };
    },
  },
  {
    method: "GET",
    path: "/admin/workspaces",
    auth: "staff",
    summary: "Find workspaces by name, slug or id. ?q= &limit=",
    response: z.array(WorkspaceRowSchema),
    handler: async (ctx) => {
      const q = (ctx.query.get("q") ?? "").trim().toLowerCase();
      const { rows } = await ctx.app.db.query<OrgRow>(
        `${ORG_SELECT} WHERE ($1 = '' OR o.id = $1 OR o.slug LIKE '%' || $1 || '%' OR lower(o.data->>'name') LIKE '%' || $1 || '%')
         ORDER BY o.created_at DESC LIMIT $2`,
        [q, limit(ctx)],
      );
      return rows.map(toRow);
    },
  },
  {
    method: "GET",
    path: "/admin/workspaces/:id",
    auth: "staff",
    summary: "One workspace: members, size and month-to-date spend. No code, logs or credentials.",
    response: z.object({
      workspace: WorkspaceRowSchema,
      organization: S.OrganizationSchema,
      members: z.array(
        z.object({ id: z.string(), name: z.string(), email: z.string(), role: S.RoleSchema }),
      ),
      counts: z.object({
        projects: z.number(),
        repositories: z.number(),
        tasks: z.number(),
        activeSessions: z.number(),
        runningTestRuns: z.number(),
        openFindings: z.number(),
        connectedIntegrations: z.array(z.string()),
      }),
      spendMonthToDateUsd: z.number(),
    }),
    handler: async (ctx) => {
      const workspace = await workspaceRow(ctx, ctx.params.id);
      const state = await ctx.app.store.read(workspace.id);
      await record(ctx, "workspace.viewed", workspace.id);
      return {
        workspace,
        organization: state.organizations[0],
        members: state.memberships.map((m) => {
          const u = state.users.find((x) => x.id === m.userId)!;
          return { id: u.id, name: u.name, email: u.email, role: m.role };
        }),
        counts: {
          projects: state.projects.length,
          repositories: state.repositories.length,
          tasks: state.tasks.length,
          activeSessions: state.sessions.filter(
            (s) => s.status === "running" || s.status === "waiting",
          ).length,
          runningTestRuns: state.testRuns.filter((r) => r.status === "running").length,
          openFindings: state.findings.filter((f) => f.status === "open").length,
          connectedIntegrations: state.integrations
            .filter((i) => i.status === "connected")
            .map((i) => i.providerId),
        },
        spendMonthToDateUsd: monthToDateSpend(state, workspace.id, ctx.now),
      };
    },
  },
  {
    method: "POST",
    path: "/admin/workspaces/:id/suspend",
    auth: "staff",
    summary:
      "Make a workspace read-only (abuse, non-payment). Members can still sign in and read their data.",
    request: ReasonSchema,
    response: WorkspaceRowSchema,
    handler: async (ctx) => {
      const { reason } = body(ReasonSchema, ctx.body);
      const workspace = await workspaceRow(ctx, ctx.params.id);
      // Audit first: once suspended, the workspace accepts no writes through the normal path.
      await ctx.app.store.write(workspace.id, (db) =>
        audit(
          db,
          workspace.id,
          STAFF_ACTOR,
          "workspace.suspended",
          `workspace:${workspace.id}`,
          reason,
          ctx.now,
        ),
      );
      await ctx.app.db.query(
        `UPDATE organizations SET suspended_at = now(), suspended_reason = $2 WHERE id = $1`,
        [workspace.id, reason],
      );
      await record(ctx, "workspace.suspended", workspace.id, reason);
      return workspaceRow(ctx, workspace.id);
    },
  },
  {
    method: "POST",
    path: "/admin/workspaces/:id/unsuspend",
    auth: "staff",
    summary: "Restore a suspended workspace.",
    request: ReasonSchema,
    response: WorkspaceRowSchema,
    handler: async (ctx) => {
      const { reason } = body(ReasonSchema, ctx.body);
      const workspace = await workspaceRow(ctx, ctx.params.id);
      await ctx.app.db.query(
        `UPDATE organizations SET suspended_at = NULL, suspended_reason = NULL WHERE id = $1`,
        [workspace.id],
      );
      await ctx.app.store.write(workspace.id, (db) =>
        audit(
          db,
          workspace.id,
          STAFF_ACTOR,
          "workspace.restored",
          `workspace:${workspace.id}`,
          reason,
          ctx.now,
        ),
      );
      await record(ctx, "workspace.restored", workspace.id, reason);
      return workspaceRow(ctx, workspace.id);
    },
  },
  {
    method: "POST",
    path: "/admin/workspaces/:id/plan",
    auth: "staff",
    summary:
      "Set a workspace's plan directly: enterprise contracts and goodwill changes. Does not touch Stripe.",
    request: SetPlanSchema,
    response: WorkspaceRowSchema,
    handler: async (ctx) => {
      const input = body(SetPlanSchema, ctx.body);
      const workspace = await workspaceRow(ctx, ctx.params.id);
      await ctx.app.store.write(workspace.id, (db) => {
        const org = db.organizations[0];
        org.plan = input.plan;
        if (input.billingCycle) org.billingCycle = input.billingCycle;
        org.trialEndsAt = null;
        audit(
          db,
          workspace.id,
          STAFF_ACTOR,
          "billing.plan_changed",
          "billing",
          `${planById(input.plan).name} · set by ForgePilot staff: ${input.reason}`,
          ctx.now,
        );
      });
      await record(ctx, "workspace.plan_set", workspace.id, `${input.plan}: ${input.reason}`);
      return workspaceRow(ctx, workspace.id);
    },
  },
  {
    method: "GET",
    path: "/admin/users",
    auth: "staff",
    summary: "Find users by name or email, with the workspaces they belong to. ?q= &limit=",
    response: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        email: z.string(),
        emailVerified: z.boolean(),
        createdAt: z.string(),
        workspaces: z.array(z.object({ id: z.string(), name: z.string(), role: S.RoleSchema })),
      }),
    ),
    handler: async (ctx) => {
      const q = (ctx.query.get("q") ?? "").trim().toLowerCase();
      const { rows } = await ctx.app.db.query<{
        id: string;
        name: string;
        email: string;
        verified: boolean;
        created_at: Date;
        workspaces: { id: string; name: string; role: S.Role }[] | null;
      }>(
        `SELECT u.id, u.name, u.email, u.email_verified_at IS NOT NULL AS verified, u.created_at,
           (SELECT jsonb_agg(jsonb_build_object('id', o.id, 'name', o.data->>'name', 'role', m.role))
              FROM memberships m JOIN organizations o ON o.id = m.org_id
              WHERE m.user_id = u.id AND m.removed_at IS NULL) AS workspaces
         FROM users u
         WHERE NOT u.is_demo AND ($1 = '' OR u.email_lower LIKE '%' || $1 || '%' OR lower(u.name) LIKE '%' || $1 || '%')
         ORDER BY u.created_at DESC LIMIT $2`,
        [q, limit(ctx)],
      );
      return rows.map((r) => ({
        id: r.id,
        name: r.name,
        email: r.email,
        emailVerified: r.verified,
        createdAt: iso(r.created_at)!,
        workspaces: r.workspaces ?? [],
      }));
    },
  },
  {
    method: "GET",
    path: "/admin/jobs",
    auth: "staff",
    summary:
      "Background jobs that are failed, queued or running. ?status=failed|queued|running &limit=",
    response: z.array(
      z.object({
        id: z.number(),
        kind: z.string(),
        workspaceId: z.string().nullable(),
        status: z.string(),
        attempts: z.number(),
        lastError: z.string().nullable(),
        runAt: z.string(),
        createdAt: z.string(),
      }),
    ),
    handler: async (ctx) => {
      const status = ctx.query.get("status") ?? "failed";
      if (!["failed", "queued", "running"].includes(status))
        throw new HttpError(422, "Unknown status");
      const { rows } = await ctx.app.db.query<{
        id: number;
        kind: string;
        org_id: string | null;
        status: string;
        attempts: number;
        last_error: string | null;
        run_at: Date;
        created_at: Date;
      }>(
        `SELECT id, kind, org_id, status, attempts, last_error, run_at, created_at FROM jobs WHERE status = $1 ORDER BY id DESC LIMIT $2`,
        [status, limit(ctx)],
      );
      return rows.map((r) => ({
        id: Number(r.id),
        kind: r.kind,
        workspaceId: r.org_id,
        status: r.status,
        attempts: r.attempts,
        lastError: r.last_error,
        runAt: iso(r.run_at)!,
        createdAt: iso(r.created_at)!,
      }));
    },
  },
  {
    method: "POST",
    path: "/admin/jobs/:id/retry",
    auth: "staff",
    summary: "Put a failed job back in the queue.",
    response: S.OkSchema,
    handler: async (ctx) => {
      const res = await ctx.app.db.query(
        `UPDATE jobs SET status = 'queued', attempts = 0, run_at = now(), finished_at = NULL, locked_by = NULL, locked_at = NULL
         WHERE id = $1 AND status = 'failed'`,
        [Number(ctx.params.id) || 0],
      );
      if (!res.rowCount) throw new HttpError(404, "No failed job with that id");
      await record(ctx, "job.retried", `job:${ctx.params.id}`);
      return { ok: true };
    },
  },
  {
    method: "GET",
    path: "/admin/sso-domains",
    auth: "staff",
    summary: "Email domains workspaces want to use for single sign-on, pending ones first.",
    response: z.array(
      z.object({
        domain: z.string(),
        workspaceId: z.string(),
        workspaceName: z.string(),
        provider: z.string(),
        status: z.enum(["pending", "approved", "rejected"]),
        requestedBy: z.string(),
        requestedAt: z.string(),
      }),
    ),
    handler: (ctx) => ctx.app.sso.listDomains(),
  },
  {
    method: "POST",
    path: "/admin/sso-domains/:domain/decision",
    auth: "staff",
    summary:
      "Approve or reject a domain claim. Approve only after confirming the workspace really controls that domain.",
    request: ReasonSchema.extend({ decision: z.enum(["approved", "rejected"]) }),
    response: S.OkSchema,
    handler: async (ctx) => {
      const input = body(
        ReasonSchema.extend({ decision: z.enum(["approved", "rejected"]) }),
        ctx.body,
      );
      const orgId = await ctx.app.sso.decide(
        ctx.params.domain.toLowerCase(),
        input.decision,
        ctx.now,
      );
      await record(
        ctx,
        `sso.domain_${input.decision}`,
        orgId,
        `${ctx.params.domain}: ${input.reason}`,
      );
      return { ok: true };
    },
  },
  {
    method: "GET",
    path: "/admin/audit",
    auth: "staff",
    summary: "What staff did in the back-office, newest first. ?limit=",
    response: z.array(
      z.object({
        id: z.number(),
        staff: z.string(),
        action: z.string(),
        target: z.string(),
        detail: z.string(),
        at: z.string(),
      }),
    ),
    handler: async (ctx) => {
      const { rows } = await ctx.app.db.query<{
        id: number;
        email: string | null;
        user_id: string;
        action: string;
        target: string;
        detail: string;
        at: Date;
      }>(
        `SELECT a.id, u.email, a.user_id, a.action, a.target, a.detail, a.at
         FROM staff_audit a LEFT JOIN users u ON u.id = a.user_id ORDER BY a.id DESC LIMIT $1`,
        [limit(ctx)],
      );
      return rows.map((r) => ({
        id: Number(r.id),
        staff: r.email ?? r.user_id,
        action: r.action,
        target: r.target,
        detail: r.detail,
        at: iso(r.at)!,
      }));
    },
  },
];
