/**
 * Workspace API route table. Each route declares method, path, permission and
 * request/response schema; the HTTP layer, OpenAPI document and contract tests
 * are generated from this table.
 *
 * Tenant isolation: a handler only ever receives the active workspace's state
 * (`ctx.db`), so a record from another workspace cannot be reached and reads as 404.
 */
import { z } from "zod";
import { fx } from "../tenancy/state";
import * as S from "../contract/schemas";
import type { Organization, Task, User } from "../contract/schemas";
import { can, meetsRole, type Permission } from "../contract/domain/permissions";
import { checkTaskAction, BOARD_COLUMNS } from "../contract/domain/workflow";
import { INTEGRATION_PROVIDERS, providerById } from "../contract/domain/integrations";
import { METER_INFO, PLANS, planById } from "../contract/domain/plans";
import { HttpError } from "../platform/errors";
import { randomToken } from "../platform/crypto";
import { newId, toIso, fakeSha } from "./support";
import type { Ctx, RouteDef } from "./context";
import {
  applyMerge,
  decideVisual,
  issueCriteria,
  issuePriority,
  audit,
  endSession,
  resumeSession,
  startScan,
  startSession,
  startTestRun,
  type IndexOutcome,
} from "./loop";
import { generateDiff, generateLog, githubCandidates, workerLog } from "./generators";
import {
  activity,
  budgetRemaining,
  bugListItem,
  DAY,
  findingListItem,
  inOrg,
  lifecycle,
  monthStart,
  monthToDateSpend,
  prListItem,
  projectSummary,
  releasePolicy,
  repositorySummary,
  runListItem,
  sessionListItem,
  spendBetween,
  taskListItem,
  verifiedTasks,
} from "./views";

export { HttpError };
export type { Ctx, RouteDef };

// ---------------------------------------------------------------- helpers
function me(ctx: Ctx): User {
  if (!ctx.user) throw new HttpError(401, "Not signed in");
  return ctx.user;
}
const person = (ctx: Ctx) => ({ type: "person" as const, id: me(ctx).id });

function org(ctx: Ctx): Organization {
  return ctx.db.organizations.find((o) => o.id === ctx.orgId)!;
}

function body<T>(schema: z.ZodType<T>, b: unknown): T {
  const r = schema.safeParse(b ?? {});
  if (!r.success) throw new HttpError(422, "Validation failed", z.flattenError(r.error));
  return r.data;
}

/** Look up a record by id inside the active workspace only (404 across tenants). */
function own<T extends { id: string; orgId: string }>(
  ctx: Ctx,
  xs: T[],
  id: string,
  what: string,
): T {
  const x = xs.find((v) => v.id === id && v.orgId === ctx.orgId);
  if (!x) throw new HttpError(404, `${what} not found`);
  return x;
}

/** The open transaction of the current write, for side tables that live outside workspace state. */
function tx(ctx: Ctx) {
  const q = fx(ctx.db).q;
  if (!q) throw new Error("This handler needs a write transaction");
  return q;
}

type RepoDescription = Pick<IndexOutcome, "defaultBranch" | "private" | "headSha"> & {
  url: string;
};

/** Additive to the UI contract: fields only a real integration needs. */
const InstallInputSchema = z.object({
  installationId: z.coerce.number().int().positive().optional(),
});
const CredentialInputSchema = z.object({
  credentials: z.record(z.string(), z.string().min(1).max(4000)).optional(),
});

function require(ctx: Ctx, p: Permission) {
  if (!can(ctx.role, p)) throw new HttpError(403, `Your role (${ctx.role}) can't do this`);
}

function policy(ctx: Ctx) {
  return ctx.db.policies.find((p) => p.orgId === ctx.orgId)!;
}

async function sessionInfo(ctx: Ctx) {
  const { db } = ctx;
  const user = me(ctx);
  return {
    user,
    workspace: org(ctx),
    role: ctx.role!,
    workspaces: ctx.workspaces,
    // Demo personas exist only in demo mode; real deployments return none.
    personas: await ctx.ports.personas(),
    counts: {
      pendingApprovals: inOrg(db.approvals, ctx.orgId).filter((a) => a.status === "pending").length,
      reviewReady: inOrg(db.tasks, ctx.orgId).filter((t) => t.status === "review_ready").length,
      unreadNotifications: inOrg(db.notifications, ctx.orgId).filter((n) => !n.read).length,
      pendingVisuals: inOrg(db.visualSnapshots, ctx.orgId).filter(
        (v) =>
          v.status === "changed" &&
          db.pullRequests.find((p) => p.id === v.pullRequestId && p.status === "open")
            ?.latestRunId === v.runId,
      ).length,
    },
  };
}

function taskDetail(ctx: Ctx, t: Task) {
  const { db } = ctx;
  const pr = t.pullRequestId ? db.pullRequests.find((p) => p.id === t.pullRequestId) : undefined;
  const p = policy(ctx);
  const rules = p.approvalRules;
  return {
    task: taskListItem(db, t),
    sessions: db.sessions
      .filter((s) => s.taskId === t.id)
      .sort((a, b) => a.attempt - b.attempt)
      .map((s) => ({ ...s, workspace: db.workspaces.find((w) => w.sessionId === s.id) ?? null })),
    approvals: db.approvals.filter((a) => a.context.taskId === t.id),
    pullRequest: pr ? prListItem(db, pr) : null,
    runs: pr
      ? db.testRuns
          .filter((r) => r.pullRequestId === pr.id)
          .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
          .map((r) => runListItem(db, r))
      : [],
    bug: t.bugId ? (db.bugs.find((b) => b.id === t.bugId) ?? null) : null,
    finding: t.findingId ? (db.findings.find((f) => f.id === t.findingId) ?? null) : null,
    parent: t.parentTaskId ? (db.tasks.find((x) => x.id === t.parentTaskId) ?? null) : null,
    children: db.tasks.filter((x) => x.parentTaskId === t.id),
    lifecycle: lifecycle(db, t),
    activity: activity(
      db,
      inOrg(db.auditLogs, ctx.orgId).filter((l) => {
        const sessIds = db.sessions.filter((s) => s.taskId === t.id).map((s) => `session:${s.id}`);
        return (
          l.resource === `task:${t.id}` ||
          sessIds.includes(l.resource) ||
          (pr && l.resource === `pr:${pr.id}`) ||
          (pr && db.testRuns.some((r) => r.pullRequestId === pr.id && l.resource === `run:${r.id}`))
        );
      }),
    ).reverse(),
    policyPreview: {
      allowed: [
        "Read the selected repository",
        "Run tests in the isolated workspace",
        `Network: ${p.networkAllowlist.join(", ")}`,
        p.requirePrApproval ? "Open a pull request (human review required)" : "Open a pull request",
      ],
      requiresApproval: [
        ...rules
          .filter((r) => r.mode === "require_approval")
          .map((r) => r.action.replace(/_/g, " ")),
        ...p.protectedPaths.map((x) => `write ${x}`),
      ],
      prohibited: rules
        .filter((r) => r.mode === "prohibited")
        .map((r) => r.action.replace(/_/g, " ")),
      budgetRemainingUsd: budgetRemaining(db, ctx.orgId, ctx.now),
    },
  };
}

function prDetail(ctx: Ctx, id: string) {
  const { db } = ctx;
  const pr = own(ctx, db.pullRequests, id, "Pull request");
  const runs = db.testRuns
    .filter((r) => r.pullRequestId === pr.id)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  const latest = runs[0];
  const policyChecks = releasePolicy(db, pr);
  const blockers = policyChecks
    .filter((c) => c.required && c.status !== "passed")
    .map((c) => `${c.name}: ${c.status}`);
  return {
    pullRequest: prListItem(db, pr),
    repository: db.repositories.find((r) => r.id === pr.repositoryId)!,
    task: pr.taskId ? (db.tasks.find((t) => t.id === pr.taskId) ?? null) : null,
    session: pr.author.sessionId
      ? (db.sessions.find((s) => s.id === pr.author.sessionId) ?? null)
      : null,
    runs: runs.map((r) => runListItem(db, r)),
    latestResults: latest
      ? db.testResults
          .filter((r) => r.runId === latest.id)
          .map((r) => ({
            ...r,
            suiteName: db.testSuites.find((s) => s.id === r.suiteId)?.name ?? "",
          }))
      : [],
    bugs: db.bugs.filter((b) => b.pullRequestId === pr.id),
    releasePolicy: policyChecks,
    mergeable: pr.status === "open" && blockers.length === 0,
    mergeBlockers: blockers,
  };
}

function createTask(ctx: Ctx, input: S.NewTaskInput) {
  const { db } = ctx;
  const parsed = body(S.NewTaskInputSchema, input);
  const repo = own(ctx, db.repositories, parsed.repositoryId, "Repository");
  const agent = own(ctx, db.agents, parsed.agentId, "Agent");
  if (!policy(ctx).allowedProviders.includes(agent.provider))
    throw new HttpError(409, `${agent.name} is not allowed by workspace policy`);
  const n = db.tasks.length + 1;
  const id = `task_${String(n).padStart(3, "0")}${Date.now().toString(36).slice(-3)}`;
  const vague = parsed.acceptanceCriteria.length < 2 || parsed.description.length < 40;
  const task: Task = {
    id,
    orgId: ctx.orgId,
    projectId: repo.projectId,
    repositoryId: repo.id,
    title: parsed.title,
    description: parsed.description,
    acceptanceCriteria: parsed.acceptanceCriteria,
    constraints: parsed.constraints,
    priority: parsed.priority,
    status: parsed.launch ? "queued" : "draft",
    source: parsed.source,
    sourceRef: parsed.sourceRef,
    createdBy: me(ctx).id,
    createdAt: toIso(ctx.now),
    agentId: agent.id,
    baseSha: repo.indexedSha,
    targetBranch: parsed.targetBranch,
    branch: `fp/${id}-${parsed.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .slice(0, 32)
      .replace(/-$/, "")}`,
    budgetUsd: parsed.budgetUsd,
    timeoutMin: parsed.timeoutMin,
    parentTaskId: parsed.parentTaskId,
    bugId: parsed.bugId,
    findingId: parsed.findingId,
    pullRequestId: null,
    assigneeId: me(ctx).id,
    clarityWarning: vague
      ? "Vague tasks produce vague PRs: add more acceptance criteria or detail."
      : null,
  };
  db.tasks.push(task);
  audit(db, ctx.orgId, person(ctx), "task.created", `task:${id}`, task.title, ctx.now);
  if (parsed.launch) {
    if (budgetRemaining(db, ctx.orgId, ctx.now) <= 0 && org(ctx).budget.hardCap)
      throw new HttpError(402, "Monthly budget exhausted (hard cap). Raise the budget in Billing.");
    startSession(db, task, person(ctx), { now: ctx.now });
  }
  return task;
}

function billing(ctx: Ctx) {
  const { db, now } = ctx;
  const o = org(ctx);
  const plan = planById(o.plan);
  const start = monthStart(now);
  const d = new Date(now);
  const end = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
  const elapsed = Math.max(1, (now - start) / DAY);
  const daysInMonth = (end - start) / DAY;
  const recs = inOrg(db.usageRecords, o.id).filter((u) => Date.parse(u.date) >= start);
  const sum = (m: S.Meter) => recs.filter((u) => u.meter === m).reduce((s, u) => s + u.units, 0);
  const usage = (Object.keys(METER_INFO) as S.Meter[]).map((meter) => {
    const info = METER_INFO[meter];
    const used = Math.round(sum(meter) * 10) / 10;
    const included = info.quotaKey ? (plan.limits[info.quotaKey] as number | null) : null;
    const projected = Math.round((used / elapsed) * daysInMonth);
    const overageUnits = included === null ? 0 : Math.max(0, used - included);
    return {
      meter,
      label: info.label,
      unit: info.unit,
      used,
      included,
      projected,
      overageUnits: Math.round(overageUnits),
      overageUsd: Math.round(overageUnits * info.overageUsd * 100) / 100,
      unitPriceUsd: info.overageUsd,
    };
  });
  const usageCost = monthToDateSpend(db, o.id, now);
  const subscription =
    (o.billingCycle === "annual" ? plan.priceAnnualMonthlyUsd : plan.priceMonthlyUsd) ?? 0;
  const byDay = new Map<string, number>();
  inOrg(db.usageRecords, o.id)
    .filter((u) => Date.parse(u.date) >= now - 30 * DAY)
    .forEach((u) => byDay.set(u.date, (byDay.get(u.date) ?? 0) + u.costUsd));
  const byProject = new Map<string, number>();
  const byProvider = new Map<string, number>();
  recs.forEach((u) => {
    byProject.set(u.projectId, (byProject.get(u.projectId) ?? 0) + u.costUsd);
    byProvider.set(u.provider, (byProvider.get(u.provider) ?? 0) + u.costUsd);
  });
  const members = db.memberships.filter((m) => m.orgId === o.id).length;
  return {
    plan: o.plan,
    billingCycle: o.billingCycle,
    seatsUsed: members,
    seatsIncluded: plan.limits.seats,
    periodStart: toIso(start),
    periodEnd: toIso(end),
    subscriptionUsd: subscription,
    usage,
    spend: {
      usageCostUsd: usageCost,
      projectedUsd: Math.round((usageCost / elapsed) * daysInMonth * 100) / 100,
      budgetUsd: o.budget.monthlyLimitUsd,
      hardCap: o.budget.hardCap,
      alertAtPct: o.budget.alertAtPct,
      pctOfBudget: o.budget.monthlyLimitUsd
        ? Math.round((usageCost / o.budget.monthlyLimitUsd) * 1000) / 10
        : 0,
    },
    dailyCost: [...byDay.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, costUsd]) => ({ date, costUsd: Math.round(costUsd * 100) / 100 })),
    costByProject: [...byProject.entries()]
      .map(([projectId, costUsd]) => ({
        projectId,
        name: db.projects.find((p) => p.id === projectId)?.name ?? projectId,
        costUsd: Math.round(costUsd * 100) / 100,
      }))
      .sort((a, b) => b.costUsd - a.costUsd),
    costByProvider: [...byProvider.entries()]
      .filter(([, c]) => c > 0)
      .map(([provider, costUsd]) => ({ provider, costUsd: Math.round(costUsd * 100) / 100 }))
      .sort((a, b) => b.costUsd - a.costUsd),
    invoices: inOrg(db.invoices, o.id).sort((a, b) => b.period.localeCompare(a.period)),
    // Real card details only ever come from Stripe; the demo shows a fictional card.
    paymentMethod: ctx.ports.stripeLive
      ? ((ctx.prepared as PaymentMethod | null | undefined) ?? null)
      : ctx.ports.demoMode && o.plan !== "free"
        ? { brand: "Visa", last4: o.id === "ws_northwind" ? "8810" : "4242", expires: "08/28" }
        : null,
    limits: [
      {
        key: "projects",
        label: "Projects",
        used: inOrg(db.projects, o.id).length,
        limit: plan.limits.projects,
      },
      {
        key: "repositories",
        label: "Repositories",
        used: inOrg(db.repositories, o.id).length,
        limit: plan.limits.repositories,
      },
      { key: "seats", label: "Seats", used: members, limit: plan.limits.seats },
      {
        key: "concurrent",
        label: "Concurrent agent sessions",
        used: inOrg(db.sessions, o.id).filter(
          (s) => s.status === "running" || s.status === "waiting",
        ).length,
        limit: plan.limits.concurrentSessions,
      },
    ],
  };
}

type PaymentMethod = { brand: string; last4: string; expires: string };
const paymentMethod = (ctx: Ctx) =>
  ctx.ports.stripeLive ? ctx.ports.billing.paymentMethod(ctx.orgId) : Promise.resolve(null);

/** Entitlement checks for a plan change; shared by the Stripe step and the state change. */
function validatePlanChange(ctx: Ctx) {
  const input = body(S.ChangePlanInputSchema, ctx.body);
  if (input.plan === "enterprise")
    throw new HttpError(409, "Enterprise is set up with our team — use “Talk to sales”.");
  const o = org(ctx);
  const target = planById(input.plan);
  const seatsUsed = ctx.db.memberships.filter((m) => m.orgId === o.id).length;
  if (target.limits.seats !== null && seatsUsed > target.limits.seats)
    throw new HttpError(
      409,
      `${target.name} includes ${target.limits.seats} seat(s); you have ${seatsUsed} members.`,
    );
  const repos = inOrg(ctx.db.repositories, o.id).length;
  if (target.limits.repositories !== null && repos > target.limits.repositories)
    throw new HttpError(
      409,
      `${target.name} allows ${target.limits.repositories} repositories; you have ${repos}.`,
    );
  return { input, target, seatsUsed };
}

const pct = (a: number, b: number) => (b ? Math.round((a / b) * 1000) / 10 : 0);

// ---------------------------------------------------------------- routes
export const routes: RouteDef[] = [
  // ===== session & auth
  {
    method: "GET",
    path: "/session",
    auth: "member",
    summary: "Current user, active workspace, role, other workspaces and badge counts.",
    response: S.SessionInfoSchema,
    handler: sessionInfo,
  },
  // ===== ShipSafe visual comparison
  {
    method: "GET",
    path: "/visual-snapshots",
    auth: "member",
    summary:
      "Visual comparisons (baseline vs candidate). ?status= &pullRequestId= &runId= &repositoryId=",
    response: z.array(S.VisualSnapshotListItemSchema),
    handler: (ctx) => {
      const q = ctx.query;
      return inOrg(ctx.db.visualSnapshots, ctx.orgId)
        .filter(
          (v) =>
            (!q.get("status") || q.get("status")!.split(",").includes(v.status)) &&
            (!q.get("pullRequestId") || v.pullRequestId === q.get("pullRequestId")) &&
            (!q.get("runId") || v.runId === q.get("runId")) &&
            (!q.get("repositoryId") || v.repositoryId === q.get("repositoryId")),
        )
        .filter(
          (v) =>
            q.get("runId") ||
            q.get("pullRequestId") ||
            !v.pullRequestId ||
            ctx.db.pullRequests.find((p) => p.id === v.pullRequestId)?.latestRunId === v.runId,
        )
        .sort(
          (a, b) =>
            (a.status === "changed" ? -1 : 0) - (b.status === "changed" ? -1 : 0) ||
            b.diffPct - a.diffPct,
        )
        .map((v) => {
          const pr = v.pullRequestId
            ? ctx.db.pullRequests.find((p) => p.id === v.pullRequestId)
            : undefined;
          return {
            ...v,
            repositoryName: ctx.db.repositories.find((r) => r.id === v.repositoryId)!.fullName,
            pullRequestNumber: pr?.number ?? null,
            pullRequestTitle: pr?.title ?? null,
            decidedByUser: ctx.db.users.find((u) => u.id === v.decidedBy) ?? null,
            bugId:
              ctx.db.bugs.find(
                (b) =>
                  b.runId === v.runId &&
                  b.title.startsWith(`Visual regression on ${v.name} (${v.viewport})`),
              )?.id ?? null,
          };
        });
    },
  },
  {
    method: "POST",
    path: "/visual-snapshots/:id/decision",
    auth: "suite.manage",
    summary:
      "Approve a changed screenshot as the new baseline, or reject it (files a visual-regression bug). Decisions are explicit and audited.",
    request: S.VisualDecisionInputSchema,
    response: S.VisualSnapshotSchema,
    handler: (ctx) => {
      const v = own(ctx, ctx.db.visualSnapshots, ctx.params.id, "Visual snapshot");
      if (v.status !== "changed" && v.status !== "new")
        throw new HttpError(409, "Only changed screenshots need a decision");
      const input = body(S.VisualDecisionInputSchema, ctx.body);
      return decideVisual(ctx.db, v.id, input.decision, input.comment ?? "", me(ctx).id, ctx.now);
    },
  },

  // ===== DevPilot: import GitHub issues as tasks
  {
    method: "GET",
    path: "/github/issues",
    auth: "member",
    summary:
      "Open issues in connected repositories, with what an import would produce. ?repositoryId= &q= &imported=true|false",
    response: z.array(S.GithubIssueListItemSchema),
    handler: (ctx) => {
      const q = (ctx.query.get("q") ?? "").toLowerCase();
      const imported = ctx.query.get("imported");
      return inOrg(ctx.db.githubIssues, ctx.orgId)
        .filter(
          (i) =>
            i.state === "open" &&
            (!ctx.query.get("repositoryId") || i.repositoryId === ctx.query.get("repositoryId")) &&
            (!q ||
              i.title.toLowerCase().includes(q) ||
              `#${i.number}`.includes(q) ||
              i.labels.some((l) => l.includes(q))) &&
            (imported === null || (imported === "true") === !!i.importedTaskId),
        )
        .sort(
          (a, b) =>
            Number(!!a.importedTaskId) - Number(!!b.importedTaskId) ||
            b.createdAt.localeCompare(a.createdAt),
        )
        .map((i) => ({
          ...i,
          repositoryName: ctx.db.repositories.find((r) => r.id === i.repositoryId)!.fullName,
          authorUser: ctx.db.users.find((u) => u.id === i.author) ?? null,
          importedTaskStatus: i.importedTaskId
            ? (ctx.db.tasks.find((t) => t.id === i.importedTaskId)?.status ?? null)
            : null,
          suggestedPriority: issuePriority(i.labels),
          suggestedCriteria: issueCriteria(i.body, i.title),
        }));
    },
  },
  {
    method: "POST",
    path: "/github/issues/import",
    auth: "task.create",
    summary:
      "Import GitHub issues as DevPilot tasks: checklists become acceptance criteria, labels set priority. Already-imported issues are skipped.",
    request: S.ImportIssuesInputSchema,
    response: S.ImportIssuesResultSchema,
    handler: (ctx) => {
      const input = body(S.ImportIssuesInputSchema, ctx.body);
      const agent = own(ctx, ctx.db.agents, input.agentId, "Agent");
      const created: Task[] = [];
      const skipped: string[] = [];
      for (const id of input.issueIds) {
        const issue = own(ctx, ctx.db.githubIssues, id, "Issue");
        if (issue.importedTaskId) {
          skipped.push(`#${issue.number} is already task ${issue.importedTaskId}`);
          continue;
        }
        const task = createTask(ctx, {
          repositoryId: issue.repositoryId,
          title: issue.title,
          description: `Imported from GitHub issue #${issue.number}.\n\n${issue.body}`.slice(
            0,
            2000,
          ),
          acceptanceCriteria: issueCriteria(issue.body, issue.title),
          constraints: ["Keep public APIs backwards compatible"],
          priority: issuePriority(issue.labels),
          agentId: agent.id,
          targetBranch: "main",
          budgetUsd: agent.defaultBudgetUsd,
          timeoutMin: agent.defaultTimeoutMin,
          launch: input.launch,
          source: "github_issue",
          sourceRef: `#${issue.number}`,
        });
        issue.importedTaskId = task.id;
        audit(
          ctx.db,
          ctx.orgId,
          person(ctx),
          "issue.imported",
          `task:${task.id}`,
          `#${issue.number} ${issue.title}`,
          ctx.now,
        );
        created.push(task);
      }
      return { tasks: created, skipped };
    },
  },

  // ===== onboarding: GitHub App + repository intelligence
  {
    method: "GET",
    path: "/github/repositories",
    auth: "member",
    summary: "Repositories visible to the GitHub App installation (mock). ?account=",
    response: z.array(S.GithubRepoCandidateSchema),
    handler: async (ctx) => {
      if (!ctx.ports.githubLive)
        return githubCandidates(
          ctx.db,
          ctx.orgId,
          ctx.query.get("account") ?? org(ctx).slug,
          ctx.now,
        );
      const connected = new Set(inOrg(ctx.db.repositories, ctx.orgId).map((r) => r.fullName));
      return (await ctx.ports.github.listRepositories(ctx.orgId)).map((r) => ({
        ...r,
        alreadyConnected: connected.has(r.fullName),
      }));
    },
  },
  {
    method: "POST",
    path: "/github/install",
    auth: "repo.connect",
    summary: "Record the GitHub App installation for the workspace (mock).",
    request: S.ConnectIntegrationInputSchema,
    response: S.IntegrationSchema,
    // With a real GitHub App the caller passes the installation id GitHub redirected back with;
    // the account name is then read from GitHub, never trusted from the request.
    prepare: async (ctx) => {
      if (!ctx.ports.githubLive) return null;
      const { installationId } = body(InstallInputSchema, ctx.body);
      if (!installationId)
        throw new HttpError(422, "installationId is required to link the GitHub App installation");
      return { installationId, ...(await ctx.ports.github.resolveInstallation(installationId)) };
    },
    handler: async (ctx) => {
      const live = ctx.prepared as { installationId: number; account: string } | null;
      const account = live?.account ?? body(S.ConnectIntegrationInputSchema, ctx.body).account;
      if (live)
        await ctx.ports.github.linkInstallation(tx(ctx), ctx.orgId, live.installationId, account);
      let i = ctx.db.integrations.find((x) => x.orgId === ctx.orgId && x.providerId === "github");
      if (!i) {
        i = {
          id: newId("int"),
          orgId: ctx.orgId,
          providerId: "github",
          status: "connected",
          account,
          connectedAt: toIso(ctx.now),
          scopes: providerById("github")!.scopes,
        };
        ctx.db.integrations.push(i);
      } else
        Object.assign(i, {
          status: "connected",
          account,
          connectedAt: toIso(ctx.now),
          error: undefined,
        });
      audit(
        ctx.db,
        ctx.orgId,
        person(ctx),
        "integration.connected",
        "integration:github",
        account,
        ctx.now,
      );
      return i;
    },
  },
  {
    method: "POST",
    path: "/repositories/connect",
    auth: "repo.connect",
    summary:
      "Connect selected repositories to a project and start indexing (repository intelligence).",
    request: S.ConnectReposInputSchema,
    response: S.ConnectReposResultSchema,
    prepare: async (ctx) => {
      if (!ctx.ports.githubLive) return null;
      const input = body(S.ConnectReposInputSchema, ctx.body);
      const connected = new Set(inOrg(ctx.db.repositories, ctx.orgId).map((r) => r.fullName));
      const described: Record<string, RepoDescription> = {};
      for (const fullName of input.repositories) {
        if (connected.has(fullName)) throw new HttpError(409, `${fullName} is already connected`);
        described[fullName] = await ctx.ports.github.describeRepository(ctx.orgId, fullName);
      }
      return described;
    },
    handler: async (ctx) => {
      const { db, now } = ctx;
      const input = body(S.ConnectReposInputSchema, ctx.body);
      const described = ctx.prepared as Record<string, RepoDescription> | null;
      const plan = planById(org(ctx).plan);
      const trial = org(ctx).trialEndsAt && Date.parse(org(ctx).trialEndsAt!) > now;
      const limit = trial ? planById("team").limits.repositories : plan.limits.repositories;
      if (
        limit !== null &&
        inOrg(db.repositories, ctx.orgId).length + input.repositories.length > limit
      )
        throw new HttpError(
          402,
          `Your plan allows ${limit} repositories. Upgrade to connect more.`,
        );
      let projectId = input.projectId;
      if (!projectId) {
        projectId = newId("proj");
        db.projects.push({
          id: projectId,
          orgId: ctx.orgId,
          name: input.newProjectName || "My project",
          description: "",
          color: "violet",
          createdAt: toIso(now),
        });
      } else own(ctx, db.projects, projectId, "Project");
      if (described) {
        // Live: register the repository with what GitHub reports and let the indexer discover the rest.
        const ids: string[] = [];
        for (const fullName of input.repositories) {
          const meta = described[fullName];
          const id = newId("repo");
          db.repositories.push({
            id,
            projectId: projectId!,
            orgId: ctx.orgId,
            provider: "github",
            fullName,
            url: meta.url,
            defaultBranch: meta.defaultBranch,
            private: meta.private,
            languages: [],
            frameworks: [],
            ecosystems: [],
            testCommands: [],
            ciWorkflows: [],
            indexedSha: meta.headSha,
            indexedAt: toIso(now),
            indexStatus: "indexing",
            fileCount: 0,
            hasDocs: false,
            scanSchedule: "daily",
            // Nothing is known until the first scan: unknown is never shown as healthy.
            health: {
              score: 0,
              scoreVersion: "v1.2",
              dependencies: null,
              security: null,
              buildStability: null,
              tests: null,
              docs: null,
            },
          });
          await ctx.ports.github.linkRepository(tx(ctx), ctx.orgId, id, fullName);
          fx(db).enqueue({
            kind: "repo.index",
            payload: { repositoryId: id },
            dedupeKey: `repo.index:${ctx.orgId}:${id}`,
          });
          audit(db, ctx.orgId, person(ctx), "repository.connected", `repo:${id}`, fullName, now);
          ids.push(id);
        }
        return { projectId, repositoryIds: ids };
      }
      const ids = input.repositories.map((fullName, i) => {
        const py = /python|pipeline|ledger|payments-api|data/i.test(fullName);
        const id = newId("repo");
        const health = {
          dependencies: 78 - i * 3,
          security: 84 - i * 5,
          buildStability: 90,
          tests: 72,
          docs: null,
        };
        db.repositories.push({
          id,
          projectId: projectId!,
          orgId: ctx.orgId,
          provider: "github",
          fullName,
          url: `https://github.com/${fullName}`,
          defaultBranch: "main",
          private: true,
          languages: [py ? "python" : "typescript"],
          frameworks: py ? ["FastAPI"] : ["Next.js", "React"],
          ecosystems: [py ? "pypi" : "npm"],
          testCommands: py ? ["pytest -q"] : ["npm test", "npx playwright test"],
          ciWorkflows: ["ci.yml"],
          indexedSha: fakeSha(fullName),
          indexedAt: toIso(now),
          indexStatus: "indexing",
          indexReadyAt: now + fx(db).sim.indexMs + i * 800,
          fileCount: 300 + i * 211,
          hasDocs: true,
          scanSchedule: "daily",
          health: {
            ...health,
            score: Math.round(
              (0.2 * health.dependencies +
                0.25 * health.security +
                0.2 * health.buildStability +
                0.2 * health.tests) /
                0.85,
            ),
            scoreVersion: "v1.2",
          },
        });
        const suites = py
          ? [
              ["Unit", "unit", "pytest -q tests/unit", ["app/**"]],
              ["API (HTTP assertions)", "api", "pytest tests/api", ["app/api/**"]],
            ]
          : [
              ["Unit", "unit", "npm test", ["src/**"]],
              [
                "End-to-end (Playwright)",
                "playwright",
                "npx playwright test",
                ["app/**", "src/**"],
              ],
            ];
        suites.forEach(([name, type, command, pathRules]) =>
          db.testSuites.push({
            id: newId("suite"),
            repositoryId: id,
            orgId: ctx.orgId,
            name: name as string,
            type: type as "unit",
            command: command as string,
            environment: type === "playwright" ? "preview" : "ci-sandbox",
            pathRules: pathRules as string[],
            timeoutMin: 20,
            owner: me(ctx).id,
            enabled: true,
            required: type !== "unit",
            flakyRatePct: 0,
            testCount: type === "unit" ? 120 : 24,
          }),
        );
        db.healthHistory.push({
          repositoryId: id,
          weekStart: toIso(now).slice(0, 10),
          score: db.repositories.at(-1)!.health.score,
        });
        audit(db, ctx.orgId, person(ctx), "repository.connected", `repo:${id}`, fullName, now);
        return id;
      });
      return { projectId, repositoryIds: ids };
    },
  },
  {
    method: "POST",
    path: "/repositories/:id/config",
    auth: "repo.connect",
    summary: "Confirm discovered test commands and scan schedule.",
    request: S.RepoConfigInputSchema,
    response: S.RepositorySchema,
    handler: (ctx) => {
      const r = own(ctx, ctx.db.repositories, ctx.params.id, "Repository");
      Object.assign(r, body(S.RepoConfigInputSchema, ctx.body));
      return r;
    },
  },
  {
    method: "POST",
    path: "/onboarding/first-run",
    auth: "test.run",
    summary: "Run the first ShipSafe test run or CodeKeeper scan for a repository.",
    request: S.FirstRunInputSchema,
    response: S.FirstRunResultSchema,
    handler: (ctx) => {
      const input = body(S.FirstRunInputSchema, ctx.body);
      const repo = own(ctx, ctx.db.repositories, input.repositoryId, "Repository");
      if (input.kind === "scan") {
        const s = startScan(ctx.db, repo, "onboarding", ctx.now);
        return { kind: "scan", id: s.id, href: `/app/repositories/${repo.id}` };
      }
      const run = startTestRun(ctx.db, repo, null, "manual", {
        now: ctx.now,
        branch: repo.defaultBranch,
      });
      return { kind: "test", id: run.id, href: `/app/shipsafe/runs/${run.id}` };
    },
  },

  // ===== overview, projects, repositories
  {
    method: "GET",
    path: "/overview",
    auth: "member",
    summary:
      "Workspace overview: North Star, KPIs, lifecycle funnel, attention list, live sessions, activity, setup checklist.",
    response: S.OverviewSchema,
    handler: (ctx) => {
      const { db, now, orgId } = ctx;
      const o = org(ctx);
      const tasks = inOrg(db.tasks, orgId);
      const prs = inOrg(db.pullRequests, orgId);
      const runs = inOrg(db.testRuns, orgId);
      const repos = inOrg(db.repositories, orgId);
      const findings = inOrg(db.findings, orgId);
      const weeks = Array.from({ length: 8 }, (_, i) => {
        const end = now - (7 - i) * 7 * DAY;
        return {
          date: toIso(end).slice(0, 10),
          value: verifiedTasks(db, orgId, end - 7 * DAY, end + 1).length,
        };
      });
      const recent = runs.filter(
        (r) =>
          Date.parse(r.startedAt) > now - 7 * DAY &&
          (r.status === "passed" || r.status === "failed"),
      );
      const prs30 = prs.filter((p) => Date.parse(p.openedAt) > now - 30 * DAY);
      const attention: S.AttentionItem[] = [];
      inOrg(db.approvals, orgId)
        .filter((a) => a.status === "pending")
        .forEach((a) =>
          attention.push({
            id: a.id,
            kind: "approval",
            title: a.title,
            detail: `Needs ${a.approverRole} approval`,
            href: "/app/approvals",
            severity: "warning",
          }),
        );
      prs
        .filter((p) => p.status === "open" && p.checkStatus === "failed")
        .forEach((p) =>
          attention.push({
            id: p.id,
            kind: "failed_check",
            title: `ShipSafe failed on #${p.number}: ${p.title}`,
            detail: db.repositories.find((r) => r.id === p.repositoryId)!.fullName,
            href: `/app/pull-requests/${p.id}`,
            severity: "danger",
          }),
        );
      tasks
        .filter((t) => t.status === "review_ready")
        .forEach((t) =>
          attention.push({
            id: t.id,
            kind: "review_ready",
            title: `Ready for review: ${t.title}`,
            detail: "Verified by ShipSafe",
            href: t.pullRequestId
              ? `/app/pull-requests/${t.pullRequestId}`
              : `/app/devpilot/tasks/${t.id}`,
            severity: "info",
          }),
        );
      findings
        .filter((f) => f.status === "open" && f.severity === "critical")
        .forEach((f) =>
          attention.push({
            id: f.id,
            kind: "critical_finding",
            title: f.title,
            detail: db.repositories.find((r) => r.id === f.repositoryId)!.fullName,
            href: `/app/codekeeper/findings?finding=${f.id}`,
            severity: "danger",
          }),
        );
      inOrg(db.integrations, orgId)
        .filter((i) => i.status === "error")
        .forEach((i) =>
          attention.push({
            id: i.id,
            kind: "integration",
            title: `${providerById(i.providerId)?.name ?? i.providerId} needs reconnecting`,
            detail: i.error ?? "",
            href: "/app/integrations",
            severity: "warning",
          }),
        );
      const spend = monthToDateSpend(db, orgId, now);
      if (o.budget.monthlyLimitUsd && spend / o.budget.monthlyLimitUsd >= 0.8)
        attention.push({
          id: "budget",
          kind: "budget",
          title: `${Math.round((spend / o.budget.monthlyLimitUsd) * 100)}% of monthly budget used`,
          detail: `$${spend.toFixed(0)} of $${o.budget.monthlyLimitUsd}`,
          href: "/app/billing",
          severity: "warning",
        });
      const order = { danger: 0, warning: 1, info: 2 };
      attention.sort((a, b) => order[a.severity] - order[b.severity]);
      const done = tasks.filter((t) => ["review_ready", "completed", "failed"].includes(t.status));
      const avgHealth = repos.length
        ? Math.round(repos.reduce((s, r) => s + r.health.score, 0) / repos.length)
        : null;
      const runsToday = runs.filter((r) => Date.parse(r.startedAt) > now - DAY).length;
      return {
        northStar: {
          value: verifiedTasks(db, orgId, monthStart(now), now + 1).length,
          previous: verifiedTasks(db, orgId, monthStart(now - 32 * DAY), monthStart(now)).length,
          weekly: weeks,
        },
        kpis: {
          activeSessions: inOrg(db.sessions, orgId).filter(
            (s) => s.status === "running" || s.status === "waiting",
          ).length,
          prsAwaitingReview: prs.filter(
            (p) => p.status === "open" && p.reviewState === "review_requested",
          ).length,
          verificationCoveragePct: pct(prs30.filter((p) => p.latestRunId).length, prs30.length),
          openBugs: inOrg(db.bugs, orgId).filter(
            (b) => b.status === "open" || b.status === "fix_in_progress",
          ).length,
          avgHealth,
          passRatePct: pct(recent.filter((r) => r.status === "passed").length, recent.length),
          spendUsd: spend,
          budgetUsd: o.budget.monthlyLimitUsd,
        },
        lifecycle: [
          {
            key: "plan",
            label: "Planned",
            count: tasks.filter((t) => t.status === "draft" || t.status === "queued").length,
            href: "/app/devpilot/tasks?status=draft",
          },
          {
            key: "execute",
            label: "Agents running",
            count: tasks.filter((t) => t.status === "running" || t.status === "waiting_input")
              .length,
            href: "/app/devpilot",
          },
          {
            key: "verify",
            label: "Verifying",
            count:
              tasks.filter((t) => t.status === "verifying").length +
              prs.filter((p) => p.status === "open" && !p.taskId && p.checkStatus === "running")
                .length,
            href: "/app/shipsafe",
          },
          {
            key: "review",
            label: "Ready for review",
            count: tasks.filter((t) => t.status === "review_ready").length,
            href: "/app/pull-requests?filter=review",
          },
          {
            key: "merge",
            label: "Merged (30d)",
            count: prs.filter(
              (p) => p.status === "merged" && Date.parse(p.mergedAt!) > now - 30 * DAY,
            ).length,
            href: "/app/pull-requests?status=merged",
          },
        ],
        attention: attention.slice(0, 8),
        activity: activity(db, inOrg(db.auditLogs, orgId).slice(0, 12)),
        liveSessions: inOrg(db.sessions, orgId)
          .filter((s) => s.status === "running" || s.status === "waiting")
          .map((s) => sessionListItem(db, s)),
        modules: {
          devpilot: {
            running: tasks.filter((t) => t.status === "running").length,
            reviewReady: tasks.filter((t) => t.status === "review_ready").length,
            successRatePct: pct(done.filter((t) => t.status !== "failed").length, done.length),
          },
          shipsafe: {
            runsToday,
            passRatePct: pct(recent.filter((r) => r.status === "passed").length, recent.length),
            openBugs: inOrg(db.bugs, orgId).filter(
              (b) => b.status !== "resolved" && b.status !== "wont_fix",
            ).length,
          },
          codekeeper: {
            avgHealth,
            openFindings: findings.filter((f) => f.status === "open").length,
            critical: findings.filter((f) => f.status === "open" && f.severity === "critical")
              .length,
          },
        },
        setup: [
          {
            key: "github",
            label: "Install the GitHub App",
            done: inOrg(db.integrations, orgId).some(
              (i) => i.providerId === "github" && i.status === "connected",
            ),
            href: "/onboarding",
          },
          {
            key: "repo",
            label: "Connect a repository",
            done: repos.length > 0,
            href: "/onboarding",
          },
          {
            key: "run",
            label: "Run your first verification",
            done: runs.length > 0,
            href: "/app/shipsafe",
          },
          {
            key: "task",
            label: "Delegate a task to an agent",
            done: tasks.length > 0,
            href: "/app/devpilot/tasks?new=1",
          },
          {
            key: "team",
            label: "Invite a teammate",
            done:
              db.memberships.filter((m) => m.orgId === orgId).length > 1 ||
              inOrg(db.invitations, orgId).length > 0,
            href: "/app/settings?tab=members",
          },
        ],
      };
    },
  },
  {
    method: "GET",
    path: "/projects",
    auth: "member",
    summary: "Projects with health, PR, session and finding counts.",
    response: z.array(S.ProjectSummarySchema),
    handler: (ctx) =>
      inOrg(ctx.db.projects, ctx.orgId).map((p) => projectSummary(ctx.db, p.id, ctx.now)),
  },
  {
    method: "POST",
    path: "/projects",
    auth: "repo.connect",
    summary: "Create a project.",
    request: S.NewProjectInputSchema,
    response: S.ProjectSchema,
    handler: (ctx) => {
      const input = body(S.NewProjectInputSchema, ctx.body);
      const limit = planById(org(ctx).plan).limits.projects;
      if (limit !== null && inOrg(ctx.db.projects, ctx.orgId).length >= limit)
        throw new HttpError(402, `Your plan allows ${limit} project(s). Upgrade for more.`);
      const p = {
        id: newId("proj"),
        orgId: ctx.orgId,
        name: input.name,
        description: input.description,
        color: "violet",
        createdAt: toIso(ctx.now),
      };
      ctx.db.projects.push(p);
      return p;
    },
  },
  {
    method: "GET",
    path: "/projects/:id",
    auth: "member",
    summary: "Project detail: repositories, tasks, PRs, runs and findings.",
    response: S.ProjectDetailSchema,
    handler: (ctx) => {
      const { db } = ctx;
      const p = own(ctx, db.projects, ctx.params.id, "Project");
      const repoIds = new Set(db.repositories.filter((r) => r.projectId === p.id).map((r) => r.id));
      return {
        project: projectSummary(db, p.id, ctx.now),
        repositories: [...repoIds].map((id) => repositorySummary(db, id)),
        tasks: db.tasks
          .filter((t) => t.projectId === p.id)
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
          .map((t) => taskListItem(db, t)),
        pullRequests: db.pullRequests
          .filter((x) => repoIds.has(x.repositoryId))
          .sort((a, b) => b.openedAt.localeCompare(a.openedAt))
          .map((x) => prListItem(db, x)),
        runs: db.testRuns
          .filter((r) => repoIds.has(r.repositoryId))
          .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
          .slice(0, 15)
          .map((r) => runListItem(db, r)),
        findings: db.findings
          .filter((f) => repoIds.has(f.repositoryId) && f.status !== "resolved")
          .map((f) => findingListItem(db, f)),
      };
    },
  },
  {
    method: "GET",
    path: "/repositories",
    auth: "member",
    summary: "Connected repositories. ?projectId=",
    response: z.array(S.RepositorySummarySchema),
    handler: (ctx) =>
      inOrg(ctx.db.repositories, ctx.orgId)
        .filter((r) => !ctx.query.get("projectId") || r.projectId === ctx.query.get("projectId"))
        .map((r) => repositorySummary(ctx.db, r.id)),
  },
  {
    method: "GET",
    path: "/repositories/:id",
    auth: "member",
    summary: "Repository detail: suites, findings, health history, scans, runs, PRs.",
    response: S.RepositoryDetailSchema,
    handler: (ctx) => {
      const { db } = ctx;
      const r = own(ctx, db.repositories, ctx.params.id, "Repository");
      return {
        repository: repositorySummary(db, r.id),
        suites: db.testSuites.filter((s) => s.repositoryId === r.id),
        findings: db.findings.filter((f) => f.repositoryId === r.id),
        dependencies: db.dependencies.filter((d) => d.repositoryId === r.id).length,
        history: db.healthHistory.filter((h) => h.repositoryId === r.id),
        scans: db.scans
          .filter((s) => s.repositoryId === r.id)
          .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
          .slice(0, 10),
        runs: db.testRuns
          .filter((x) => x.repositoryId === r.id)
          .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
          .slice(0, 15)
          .map((x) => runListItem(db, x)),
        pullRequests: db.pullRequests
          .filter((p) => p.repositoryId === r.id)
          .sort((a, b) => b.openedAt.localeCompare(a.openedAt))
          .map((p) => prListItem(db, p)),
      };
    },
  },
  {
    method: "POST",
    path: "/repositories/:id/scans",
    auth: "test.run",
    summary: "Start a CodeKeeper scan of the repository.",
    response: S.ScanSchema,
    handler: (ctx) => {
      const r = own(ctx, ctx.db.repositories, ctx.params.id, "Repository");
      const running = ctx.db.scans.find((s) => s.repositoryId === r.id && s.status === "running");
      return running ?? startScan(ctx.db, r, "manual", ctx.now);
    },
  },

  // ===== DevPilot
  {
    method: "GET",
    path: "/devpilot/overview",
    auth: "member",
    summary: "DevPilot command centre: KPIs, board, live sessions, agents.",
    response: S.DevPilotOverviewSchema,
    handler: (ctx) => {
      const { db, now, orgId } = ctx;
      const tasks = inOrg(db.tasks, orgId)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .map((t) => taskListItem(db, t));
      const done = tasks.filter((t) => ["review_ready", "completed", "failed"].includes(t.status));
      const sessions30 = inOrg(db.sessions, orgId).filter(
        (s) => Date.parse(s.startedAt) > now - 30 * DAY,
      );
      const board: Record<string, S.TaskListItem[]> = {};
      BOARD_COLUMNS.forEach(
        (c) => (board[c.key] = tasks.filter((t) => c.statuses.includes(t.status))),
      );
      return {
        kpis: {
          running: tasks.filter((t) => t.status === "running").length,
          waiting: tasks.filter((t) => t.status === "waiting_input").length,
          reviewReady: tasks.filter((t) => t.status === "review_ready").length,
          successRatePct: pct(done.filter((t) => t.status !== "failed").length, done.length),
          avgCostUsd: sessions30.length
            ? Math.round(
                (sessions30.reduce((s, x) => s + x.costUsd, 0) / sessions30.length) * 100,
              ) / 100
            : 0,
          spend30dUsd: Math.round(sessions30.reduce((s, x) => s + x.costUsd, 0) * 100) / 100,
        },
        board,
        liveSessions: inOrg(db.sessions, orgId)
          .filter((s) => s.status === "running" || s.status === "waiting")
          .map((s) => sessionListItem(db, s)),
        agents: inOrg(db.agents, orgId).map((a) => {
          const ss = sessions30.filter((s) => s.agentId === a.id);
          const ended = ss.filter((s) => s.status === "completed" || s.status === "failed");
          return {
            ...a,
            running: ss.filter((s) => s.status === "running").length,
            sessions30d: ss.length,
            successRatePct: pct(ended.filter((s) => s.status === "completed").length, ended.length),
            costUsd30d: Math.round(ss.reduce((s, x) => s + x.costUsd, 0) * 100) / 100,
          };
        }),
      };
    },
  },
  {
    method: "GET",
    path: "/tasks",
    auth: "member",
    summary: "Tasks. Filters: status, projectId, repositoryId, source, agentId, q.",
    response: z.array(S.TaskListItemSchema),
    handler: (ctx) => {
      const q = ctx.query;
      const text = (q.get("q") ?? "").toLowerCase();
      return inOrg(ctx.db.tasks, ctx.orgId)
        .filter(
          (t) =>
            (!q.get("status") || q.get("status")!.split(",").includes(t.status)) &&
            (!q.get("projectId") || t.projectId === q.get("projectId")) &&
            (!q.get("repositoryId") || t.repositoryId === q.get("repositoryId")) &&
            (!q.get("source") || t.source === q.get("source")) &&
            (!q.get("agentId") || t.agentId === q.get("agentId")) &&
            (!text || t.title.toLowerCase().includes(text) || t.id.includes(text)),
        )
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .map((t) => taskListItem(ctx.db, t));
    },
  },
  {
    method: "POST",
    path: "/tasks",
    auth: "task.create",
    summary: "Create a task (optionally launch it). Validates policy, agent and budget.",
    request: S.NewTaskInputSchema,
    response: S.TaskSchema,
    handler: (ctx) => createTask(ctx, ctx.body as S.NewTaskInput),
  },
  {
    method: "GET",
    path: "/tasks/:id",
    auth: "member",
    summary:
      "Task detail: sessions, approvals, PR, verification runs, linked bug/finding, lifecycle, activity, policy preview.",
    response: S.TaskDetailSchema,
    handler: (ctx) => taskDetail(ctx, own(ctx, ctx.db.tasks, ctx.params.id, "Task")),
  },
  {
    method: "POST",
    path: "/tasks/:id/actions",
    auth: "task.launch",
    summary:
      "launch | cancel | retry | archive. Enforces the task state machine, retry cap and budget hard cap.",
    request: S.TaskActionInputSchema,
    response: S.TaskDetailSchema,
    handler: (ctx) => {
      const { db, now } = ctx;
      const t = own(ctx, db.tasks, ctx.params.id, "Task");
      const input = body(S.TaskActionInputSchema, ctx.body);
      const attempts = db.sessions.filter((s) => s.taskId === t.id).length;
      const o = org(ctx);
      const check = checkTaskAction(input.action, {
        status: t.status,
        attempts,
        hasAgent: !!t.agentId,
        maxRetries: policy(ctx).maxFixRetries,
        budgetRemainingUsd: o.budget.hardCap ? budgetRemaining(db, ctx.orgId, now) : undefined,
      });
      if (!check.allowed) throw new HttpError(409, check.reason ?? "Not allowed");
      const s = db.sessions.filter((x) => x.taskId === t.id).at(-1);
      if (input.action === "launch" || input.action === "retry")
        startSession(db, t, person(ctx), {
          now,
          notes: input.notes,
          simulateFailure: input.simulateFailure,
        });
      if (input.action === "cancel") {
        if (s && (s.status === "running" || s.status === "waiting"))
          endSession(db, s, "cancelled", "Cancelled by " + me(ctx).name, now);
        t.status = "cancelled";
        audit(db, ctx.orgId, person(ctx), "task.cancelled", `task:${t.id}`, "", now);
      }
      return taskDetail(ctx, t);
    },
  },
  {
    method: "GET",
    path: "/sessions",
    auth: "member",
    summary: "Agent sessions. ?status=",
    response: z.array(S.SessionListItemSchema),
    handler: (ctx) =>
      inOrg(ctx.db.sessions, ctx.orgId)
        .filter(
          (s) => !ctx.query.get("status") || ctx.query.get("status")!.split(",").includes(s.status),
        )
        .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
        .map((s) => sessionListItem(ctx.db, s)),
  },
  {
    method: "GET",
    path: "/sessions/:id",
    auth: "member",
    summary: "Session detail with workspace, approvals and other attempts.",
    response: S.SessionDetailSchema,
    handler: (ctx) => {
      const s = own(ctx, ctx.db.sessions, ctx.params.id, "Session");
      return {
        session: sessionListItem(ctx.db, s),
        task: ctx.db.tasks.find((t) => t.id === s.taskId)!,
        workspace: ctx.db.workspaces.find((w) => w.sessionId === s.id) ?? null,
        approvals: ctx.db.approvals.filter((a) => a.context.sessionId === s.id),
        otherAttempts: ctx.db.sessions.filter((x) => x.taskId === s.taskId && x.id !== s.id),
      };
    },
  },
  {
    method: "GET",
    path: "/sessions/:id/log",
    auth: "member",
    summary: "Structured, secret-redacted session log (poll every ~1.2s while running).",
    response: S.LiveLogSchema,
    handler: async (ctx) => {
      const s = own(ctx, ctx.db.sessions, ctx.params.id, "Session");
      if (s.simulated) return generateLog(ctx.db, s, ctx.now);
      // Live sessions: lines were redacted and persisted by the execution plane as they happened.
      const lines = (await ctx.ports.sessions.log(ctx.orgId, s.id)).slice(-400);
      const task = ctx.db.tasks.find((t) => t.id === s.taskId)!;
      const elapsed = ctx.now - Date.parse(s.startedAt);
      return {
        sessionId: s.id,
        status: s.status,
        lines,
        progressPct: s.endedAt
          ? 100
          : s.status === "waiting"
            ? 50
            : Math.min(97, Math.round((elapsed / (task.timeoutMin * 60_000)) * 100)),
        redactions: lines.filter((l) => l.text.includes("[REDACTED]")).length,
      };
    },
  },
  {
    method: "GET",
    path: "/sessions/:id/diff",
    auth: "member",
    summary: "Changed files with hunks for the session's commit.",
    response: z.array(S.DiffFileSchema),
    handler: async (ctx) => {
      const s = own(ctx, ctx.db.sessions, ctx.params.id, "Session");
      const t = ctx.db.tasks.find((x) => x.id === s.taskId)!;
      if (!s.simulated) return (await ctx.ports.sessions.diff(ctx.orgId, s.id)) ?? [];
      return generateDiff(
        t,
        ctx.db.repositories.find((r) => r.id === t.repositoryId)!,
        s.changedFiles,
        true,
      );
    },
  },
  {
    method: "POST",
    path: "/sessions/:id/cancel",
    auth: "task.cancel",
    summary: "Cancel an active session; the worker is terminated and the workspace cleaned up.",
    response: S.SessionListItemSchema,
    handler: (ctx) => {
      const s = own(ctx, ctx.db.sessions, ctx.params.id, "Session");
      if (s.status !== "running" && s.status !== "waiting")
        throw new HttpError(409, "Session is not active");
      endSession(ctx.db, s, "cancelled", "Cancelled by " + me(ctx).name, ctx.now);
      return sessionListItem(ctx.db, s);
    },
  },
  {
    method: "GET",
    path: "/workspaces",
    auth: "member",
    summary: "Isolated execution workspaces (one per session).",
    response: z.array(
      S.WorkspaceSchema.extend({
        taskTitle: z.string(),
        sessionStatus: S.SessionStatusSchema,
        repositoryName: z.string(),
      }),
    ),
    handler: (ctx) =>
      inOrg(ctx.db.workspaces, ctx.orgId)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .map((w) => {
          const s = ctx.db.sessions.find((x) => x.id === w.sessionId)!;
          const t = ctx.db.tasks.find((x) => x.id === s.taskId)!;
          return {
            ...w,
            taskTitle: t.title,
            sessionStatus: s.status,
            repositoryName: ctx.db.repositories.find((r) => r.id === t.repositoryId)!.fullName,
          };
        }),
  },
  {
    method: "GET",
    path: "/agents",
    auth: "member",
    summary: "Configured coding-agent runtimes.",
    response: z.array(S.AgentSchema),
    handler: (ctx) => inOrg(ctx.db.agents, ctx.orgId),
  },
  {
    method: "POST",
    path: "/agents/:id",
    auth: "agent.manage",
    summary: "Update or suspend an agent runtime.",
    request: z.object({
      status: z.enum(["active", "suspended"]).optional(),
      maxConcurrent: z.number().int().min(1).max(50).optional(),
      defaultBudgetUsd: z.number().min(0).optional(),
      defaultTimeoutMin: z.number().min(5).optional(),
    }),
    response: S.AgentSchema,
    handler: (ctx) => {
      const a = own(ctx, ctx.db.agents, ctx.params.id, "Agent");
      Object.assign(
        a,
        body(
          z.object({
            status: z.enum(["active", "suspended"]).optional(),
            maxConcurrent: z.number().int().min(1).max(50).optional(),
            defaultBudgetUsd: z.number().min(0).optional(),
            defaultTimeoutMin: z.number().min(5).optional(),
          }),
          ctx.body,
        ),
      );
      audit(ctx.db, ctx.orgId, person(ctx), "agent.updated", `agent:${a.id}`, a.status, ctx.now);
      return a;
    },
  },

  // ===== ShipSafe
  {
    method: "GET",
    path: "/shipsafe/overview",
    auth: "member",
    summary:
      "Testing dashboard: pass-rate trend, KPIs, failure classes, repositories, recent runs, open bugs.",
    response: S.ShipSafeOverviewSchema,
    handler: (ctx) => {
      const { db, now, orgId } = ctx;
      const runs = inOrg(db.testRuns, orgId);
      const days = Array.from({ length: 30 }, (_, i) => toIso(now - (29 - i) * DAY).slice(0, 10));
      const done7 = runs.filter(
        (r) =>
          Date.parse(r.startedAt) > now - 7 * DAY &&
          (r.status === "passed" || r.status === "failed"),
      );
      const durations = runs
        .filter((r) => r.durationSec)
        .map((r) => r.durationSec!)
        .sort((a, b) => a - b);
      const results = db.testResults.filter((r) => runs.some((x) => x.id === r.runId));
      const classified = results.filter((r) => r.classification);
      const prs30 = inOrg(db.pullRequests, orgId).filter(
        (p) => Date.parse(p.openedAt) > now - 30 * DAY,
      );
      const bugs = inOrg(db.bugs, orgId);
      const suites = inOrg(db.testSuites, orgId);
      const classes: S.FailureClass[] = [
        "product_defect",
        "test_defect",
        "environment",
        "flaky",
        "infrastructure",
      ];
      return {
        passRateTrend: days.map((d) => {
          const rs = runs.filter(
            (r) =>
              r.startedAt.slice(0, 10) === d && (r.status === "passed" || r.status === "failed"),
          );
          return {
            date: d,
            passRatePct: rs.length
              ? pct(rs.filter((r) => r.status === "passed").length, rs.length)
              : 0,
            runs: rs.length,
          };
        }),
        kpis: {
          runs7d: runs.filter((r) => Date.parse(r.startedAt) > now - 7 * DAY).length,
          passRatePct: pct(done7.filter((r) => r.status === "passed").length, done7.length),
          medianDurationSec: durations.length ? durations[Math.floor(durations.length / 2)] : 0,
          flakyRatePct: suites.length
            ? Math.round((suites.reduce((s, x) => s + x.flakyRatePct, 0) / suites.length) * 10) / 10
            : 0,
          openBugs: bugs.filter((b) => b.status === "open" || b.status === "fix_in_progress")
            .length,
          verificationCoveragePct: pct(prs30.filter((p) => p.latestRunId).length, prs30.length),
          actionableDefectPct: pct(
            bugs.filter((b) => b.status !== "wont_fix").length,
            Math.max(1, classified.filter((r) => r.classification !== "flaky").length),
          ),
        },
        failureBreakdown: classes.map((c) => ({
          classification: c,
          count:
            classified.filter((r) => r.classification === c).length +
            (c === "infrastructure" ? runs.filter((r) => r.status === "errored").length : 0),
        })),
        repositories: inOrg(db.repositories, orgId).map((r) => {
          const rs = runs.filter(
            (x) => x.repositoryId === r.id && (x.status === "passed" || x.status === "failed"),
          );
          const last = runs
            .filter((x) => x.repositoryId === r.id)
            .sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
          return {
            repositoryId: r.id,
            name: r.fullName,
            passRatePct: pct(rs.filter((x) => x.status === "passed").length, rs.length),
            runs: rs.length,
            lastStatus: last?.status ?? null,
          };
        }),
        recentRuns: runs
          .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
          .slice(0, 12)
          .map((r) => runListItem(db, r)),
        openBugs: bugs
          .filter((b) => b.status === "open" || b.status === "fix_in_progress")
          .map((b) => bugListItem(db, b)),
      };
    },
  },
  {
    method: "GET",
    path: "/test-suites",
    auth: "member",
    summary: "Test suites. ?repositoryId=",
    response: z.array(
      S.TestSuiteSchema.extend({ repositoryName: z.string(), lastStatus: z.string().nullable() }),
    ),
    handler: (ctx) =>
      inOrg(ctx.db.testSuites, ctx.orgId)
        .filter(
          (s) => !ctx.query.get("repositoryId") || s.repositoryId === ctx.query.get("repositoryId"),
        )
        .map((s) => {
          const last = ctx.db.testRuns
            .filter(
              (r) => r.selectedSuites.some((x) => x.suiteId === s.id) && r.status !== "running",
            )
            .sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
          return {
            ...s,
            repositoryName: ctx.db.repositories.find((r) => r.id === s.repositoryId)!.fullName,
            lastStatus: last?.status ?? null,
          };
        }),
  },
  {
    method: "POST",
    path: "/test-suites",
    auth: "suite.manage",
    summary: "Create a test suite.",
    request: S.TestSuiteInputSchema,
    response: S.TestSuiteSchema,
    handler: (ctx) => {
      const input = body(S.TestSuiteInputSchema, ctx.body);
      own(ctx, ctx.db.repositories, input.repositoryId, "Repository");
      const s = {
        id: newId("suite"),
        orgId: ctx.orgId,
        ...input,
        owner: me(ctx).id,
        enabled: true,
        flakyRatePct: 0,
        testCount: 0,
      };
      ctx.db.testSuites.push(s);
      audit(ctx.db, ctx.orgId, person(ctx), "suite.created", `suite:${s.id}`, s.name, ctx.now);
      return s;
    },
  },
  {
    method: "POST",
    path: "/test-suites/:id",
    auth: "suite.manage",
    summary: "Update a test suite (enable/disable, required, command, timeout).",
    request: S.TestSuitePatchSchema,
    response: S.TestSuiteSchema,
    handler: (ctx) => {
      const s = own(ctx, ctx.db.testSuites, ctx.params.id, "Suite");
      Object.assign(s, body(S.TestSuitePatchSchema, ctx.body));
      return s;
    },
  },
  {
    method: "GET",
    path: "/test-runs",
    auth: "member",
    summary: "Test runs. ?repositoryId= &status= &pullRequestId= &trigger=",
    response: z.array(S.TestRunListItemSchema),
    handler: (ctx) => {
      const q = ctx.query;
      return inOrg(ctx.db.testRuns, ctx.orgId)
        .filter(
          (r) =>
            (!q.get("repositoryId") || r.repositoryId === q.get("repositoryId")) &&
            (!q.get("status") || r.status === q.get("status")) &&
            (!q.get("pullRequestId") || r.pullRequestId === q.get("pullRequestId")) &&
            (!q.get("trigger") ||
              (q.get("trigger") === "pr" ? !!r.pullRequestId : !r.pullRequestId)),
        )
        .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
        .slice(0, 200)
        .map((r) => runListItem(ctx.db, r));
    },
  },
  {
    method: "POST",
    path: "/test-runs",
    auth: "test.run",
    summary: "Start a manual test run on a branch.",
    request: S.NewTestRunInputSchema,
    response: S.TestRunSchema,
    handler: (ctx) => {
      const input = body(S.NewTestRunInputSchema, ctx.body);
      const repo = own(ctx, ctx.db.repositories, input.repositoryId, "Repository");
      return startTestRun(ctx.db, repo, null, "manual", {
        now: ctx.now,
        branch: input.branch,
        simulateFailure: input.simulateFailure,
      });
    },
  },
  {
    method: "GET",
    path: "/test-runs/:id",
    auth: "member",
    summary:
      "Run detail: environment, commit pins, test plan with reasons, results, evidence, comparison with the previous run, worker log.",
    response: S.TestRunDetailSchema,
    handler: async (ctx) => {
      const { db } = ctx;
      const run = own(ctx, db.testRuns, ctx.params.id, "Test run");
      const results = db.testResults.filter((r) => r.runId === run.id);
      const suites = run.selectedSuites.map((x) => {
        const s = db.testSuites.find((y) => y.id === x.suiteId)!;
        const rs = results.filter((r) => r.suiteId === s.id);
        return {
          ...s,
          reason: x.reason,
          passed: rs.filter((r) => r.outcome === "passed").length,
          failed: rs.filter((r) => r.outcome === "failed").length,
          flaky: rs.filter((r) => r.outcome === "flaky").length,
        };
      });
      const previous = run.retestOf
        ? (db.testRuns.find((r) => r.id === run.retestOf) ?? null)
        : run.pullRequestId
          ? (db.testRuns
              .filter((r) => r.pullRequestId === run.pullRequestId && r.startedAt < run.startedAt)
              .sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0] ?? null)
          : null;
      let comparison = null;
      if (previous) {
        const failedNow = new Set(results.filter((r) => r.outcome === "failed").map((r) => r.name));
        const failedBefore = new Set(
          db.testResults
            .filter((r) => r.runId === previous.id && r.outcome === "failed")
            .map((r) => r.name),
        );
        comparison = {
          newlyFailing: [...failedNow].filter((n) => !failedBefore.has(n)),
          fixed: [...failedBefore].filter((n) => !failedNow.has(n)),
          stillFailing: [...failedNow].filter((n) => failedBefore.has(n)),
        };
      }
      return {
        run: runListItem(db, run),
        repository: db.repositories.find((r) => r.id === run.repositoryId)!,
        pullRequest: run.pullRequestId
          ? (db.pullRequests.find((p) => p.id === run.pullRequestId) ?? null)
          : null,
        suites,
        results: results.map((r) => ({
          ...r,
          suiteName: db.testSuites.find((s) => s.id === r.suiteId)?.name ?? "",
        })),
        previous,
        comparison,
        bugs: db.bugs.filter((b) => b.runId === run.id),
        // Live runs show what the worker actually logged; only simulated runs use the generated narrative.
        workerLog:
          (ctx.ports.executionLive ? await ctx.ports.runs.workerLog(ctx.orgId, run.id) : null) ??
          workerLog(
            run,
            suites.map((s) => s.name),
          ),
      };
    },
  },
  {
    method: "POST",
    path: "/test-runs/:id/rerun",
    auth: "test.run",
    summary: "Rerun with the same commit pin (infra failures rerun free).",
    response: S.TestRunSchema,
    handler: (ctx) => {
      const run = own(ctx, ctx.db.testRuns, ctx.params.id, "Test run");
      const repo = ctx.db.repositories.find((r) => r.id === run.repositoryId)!;
      const pr = run.pullRequestId
        ? (ctx.db.pullRequests.find((p) => p.id === run.pullRequestId) ?? null)
        : null;
      return startTestRun(ctx.db, repo, pr, "rerun", {
        now: ctx.now,
        retestOf: run.id,
        branch: run.branch,
      });
    },
  },
  {
    method: "GET",
    path: "/bugs",
    auth: "member",
    summary: "Bugs from ShipSafe failures. ?status= &severity=",
    response: z.array(S.BugListItemSchema),
    handler: (ctx) =>
      inOrg(ctx.db.bugs, ctx.orgId)
        .filter(
          (b) =>
            (!ctx.query.get("status") || b.status === ctx.query.get("status")) &&
            (!ctx.query.get("severity") || b.severity === ctx.query.get("severity")),
        )
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .map((b) => bugListItem(ctx.db, b)),
  },
  {
    method: "GET",
    path: "/bugs/:id",
    auth: "member",
    summary: "Bug detail with the failing result, evidence, run, PR and fix task.",
    response: S.BugDetailSchema,
    handler: (ctx) => {
      const b = own(ctx, ctx.db.bugs, ctx.params.id, "Bug");
      return {
        bug: bugListItem(ctx.db, b),
        result: ctx.db.testResults.find((r) => r.id === b.resultId)!,
        run: ctx.db.testRuns.find((r) => r.id === b.runId)!,
        pullRequest: b.pullRequestId
          ? (ctx.db.pullRequests.find((p) => p.id === b.pullRequestId) ?? null)
          : null,
        task: b.taskId ? (ctx.db.tasks.find((t) => t.id === b.taskId) ?? null) : null,
        repository: ctx.db.repositories.find((r) => r.id === b.repositoryId)!,
      };
    },
  },
  {
    method: "POST",
    path: "/bugs/:id/actions",
    auth: "bug.manage",
    summary:
      "create_fix_task (SS-012: preserves commit, logs and context; capped retries) | resolve | wont_fix | reopen.",
    request: S.BugActionInputSchema,
    response: S.BugDetailSchema,
    handler: (ctx) => {
      const { db, now } = ctx;
      const b = own(ctx, db.bugs, ctx.params.id, "Bug");
      const input = body(S.BugActionInputSchema, ctx.body);
      if (input.action === "create_fix_task") {
        const prior = db.tasks.filter((t) => t.bugId === b.id).length;
        if (prior >= policy(ctx).maxFixRetries)
          throw new HttpError(
            409,
            `This bug already had ${prior} fix attempts (limit ${policy(ctx).maxFixRetries}). Escalate to a human.`,
          );
        const result = db.testResults.find((r) => r.id === b.resultId)!;
        const parent = b.pullRequestId
          ? db.tasks.find((t) => t.pullRequestId === b.pullRequestId && t.id !== b.taskId)
          : undefined;
        const agentId =
          input.agentId ?? inOrg(db.agents, ctx.orgId).find((a) => a.status === "active")?.id;
        if (!agentId)
          throw new HttpError(409, "No active agent runtime. Connect one in Integrations.");
        const task = createTask(ctx, {
          repositoryId: b.repositoryId,
          title: `Fix: ${b.title}`,
          description: `ShipSafe found a product defect on ${b.commitSha.slice(0, 7)}. Failing test: ${result.name}. Error: ${result.error}. Suspected cause: ${b.suspectedCause}`,
          acceptanceCriteria: [
            `\`${result.name}\` passes`,
            "No other ShipSafe checks regress",
            "Regression test kept in the suite",
          ],
          constraints: ["Push to the existing PR branch", "Do not modify unrelated files"],
          priority: b.severity === "critical" ? "urgent" : "high",
          agentId,
          targetBranch: "main",
          budgetUsd: 5,
          timeoutMin: 30,
          launch: true,
          source: "shipsafe_failure",
          bugId: b.id,
          parentTaskId: parent?.id ?? null,
        });
        task.pullRequestId = b.pullRequestId;
        b.taskId = task.id;
        b.status = "fix_in_progress";
        audit(db, ctx.orgId, person(ctx), "bug.fix_task_created", `bug:${b.id}`, task.id, now);
      } else {
        b.status =
          input.action === "resolve"
            ? "resolved"
            : input.action === "wont_fix"
              ? "wont_fix"
              : "open";
        audit(
          db,
          ctx.orgId,
          person(ctx),
          `bug.${input.action}`,
          `bug:${b.id}`,
          input.comment ?? "",
          now,
        );
      }
      return routes.find((r) => r.path === "/bugs/:id")!.handler(ctx);
    },
  },

  // ===== pull requests
  {
    method: "GET",
    path: "/pull-requests",
    auth: "member",
    summary:
      "Pull requests (agent and human) with verification status. ?status= &author=agent|person &repositoryId= &filter=review",
    response: z.array(S.PullRequestListItemSchema),
    handler: (ctx) => {
      const q = ctx.query;
      return inOrg(ctx.db.pullRequests, ctx.orgId)
        .filter(
          (p) =>
            (!q.get("status") || p.status === q.get("status")) &&
            (!q.get("author") || p.author.type === q.get("author")) &&
            (!q.get("repositoryId") || p.repositoryId === q.get("repositoryId")) &&
            (q.get("filter") !== "review" || (p.status === "open" && p.checkStatus === "passed")),
        )
        .sort((a, b) => b.openedAt.localeCompare(a.openedAt))
        .map((p) => prListItem(ctx.db, p));
    },
  },
  {
    method: "GET",
    path: "/pull-requests/:id",
    auth: "member",
    summary: "PR verification detail: runs, results, bugs, release policy and merge blockers.",
    response: S.PullRequestDetailSchema,
    handler: (ctx) => prDetail(ctx, ctx.params.id),
  },
  {
    method: "GET",
    path: "/pull-requests/:id/diff",
    auth: "member",
    summary: "Diff for the PR head.",
    response: z.array(S.DiffFileSchema),
    handler: async (ctx) => {
      const pr = own(ctx, ctx.db.pullRequests, ctx.params.id, "Pull request");
      const repo = ctx.db.repositories.find((r) => r.id === pr.repositoryId)!;
      const task = pr.taskId ? ctx.db.tasks.find((t) => t.id === pr.taskId) : undefined;
      if (ctx.ports.githubLive) {
        const files = await ctx.ports.github.pullRequestDiff(ctx.orgId, repo.fullName, pr.number);
        return files.map((f) => ({ ...f, aiAuthored: pr.author.type === "agent" }));
      }
      const files = ctx.db.sessions.find((s) => s.id === pr.author.sessionId)?.changedFiles ?? [
        {
          path:
            repo.ecosystems[0] === "pypi" ? "app/api/handlers.py" : "src/components/Feature.tsx",
          additions: Math.round(pr.additions * 0.6),
          deletions: pr.deletions,
        },
        {
          path:
            repo.ecosystems[0] === "pypi"
              ? "tests/api/test_handlers.py"
              : "src/components/Feature.test.tsx",
          additions: Math.round(pr.additions * 0.4),
          deletions: 0,
        },
      ];
      return generateDiff(
        task ?? { title: pr.title, acceptanceCriteria: [pr.title] },
        repo,
        files,
        pr.author.type === "agent",
      );
    },
  },
  {
    method: "POST",
    path: "/pull-requests/:id/review",
    auth: "pr.review",
    summary: "Record a human review (mirrors the GitHub review).",
    request: S.ReviewInputSchema,
    response: S.PullRequestDetailSchema,
    handler: (ctx) => {
      const pr = own(ctx, ctx.db.pullRequests, ctx.params.id, "Pull request");
      const input = body(S.ReviewInputSchema, ctx.body);
      pr.reviewState = input.decision;
      if (!pr.reviewers.includes(me(ctx).id)) pr.reviewers.push(me(ctx).id);
      audit(
        ctx.db,
        ctx.orgId,
        person(ctx),
        "pull_request.reviewed",
        `pr:${pr.id}`,
        input.decision.replace("_", " "),
        ctx.now,
      );
      return prDetail(ctx, pr.id);
    },
  },
  {
    method: "POST",
    path: "/pull-requests/:id/merge",
    auth: "pr.review",
    summary:
      "Demo only: simulate the GitHub merge webhook. Refused while required checks or review are missing.",
    response: S.PullRequestDetailSchema,
    handler: (ctx) => {
      // GitHub is the source of truth for merges: with a real GitHub App the state arrives by webhook.
      if (ctx.ports.githubLive)
        throw new HttpError(
          409,
          "Merge this pull request in GitHub. ForgePilot never merges for you; the status updates here as soon as GitHub reports it.",
        );
      const detail = prDetail(ctx, ctx.params.id);
      if (!detail.mergeable)
        throw new HttpError(409, `Not mergeable: ${detail.mergeBlockers.join("; ")}`);
      applyMerge(
        ctx.db,
        ctx.db.pullRequests.find((p) => p.id === ctx.params.id)!,
        me(ctx).id,
        ctx.now,
      );
      return prDetail(ctx, ctx.params.id);
    },
  },

  // ===== CodeKeeper
  {
    method: "GET",
    path: "/codekeeper/overview",
    auth: "member",
    summary:
      "Repository health: average and trend, per-repository scores, findings breakdown, scans, maintenance PR acceptance, prioritised queue.",
    response: S.CodeKeeperOverviewSchema,
    handler: (ctx) => {
      const { db, orgId } = ctx;
      const repos = inOrg(db.repositories, orgId);
      const findings = inOrg(db.findings, orgId);
      const open = findings.filter((f) => f.status === "open" || f.status === "task_created");
      const weeks = [
        ...new Set(
          db.healthHistory
            .filter((h) => repos.some((r) => r.id === h.repositoryId))
            .map((h) => h.weekStart),
        ),
      ]
        .sort()
        .slice(-12);
      const count = (key: "severity" | "category") =>
        open.reduce<Record<string, number>>(
          (acc, f) => ((acc[f[key]] = (acc[f[key]] ?? 0) + 1), acc),
          {},
        );
      const maintTasks = inOrg(db.tasks, orgId).filter((t) => t.source === "codekeeper_finding");
      const maintPrs = maintTasks
        .map((t) => db.pullRequests.find((p) => p.id === t.pullRequestId))
        .filter(Boolean);
      const rank = { urgent: 0, high: 1, medium: 2, low: 3 };
      return {
        avgHealth: repos.length
          ? Math.round(repos.reduce((s, r) => s + r.health.score, 0) / repos.length)
          : null,
        healthTrend: weeks.map((w) => {
          const hs = db.healthHistory.filter(
            (h) => h.weekStart === w && repos.some((r) => r.id === h.repositoryId),
          );
          return {
            date: w,
            value: Math.round(hs.reduce((s, h) => s + h.score, 0) / Math.max(1, hs.length)),
          };
        }),
        repositories: repos.map((r) => repositorySummary(db, r.id)),
        findingsBySeverity: count("severity"),
        findingsByCategory: count("category"),
        recentScans: inOrg(db.scans, orgId)
          .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
          .slice(0, 8)
          .map((s) => ({
            ...s,
            repositoryName: db.repositories.find((r) => r.id === s.repositoryId)!.fullName,
          })),
        maintenance: {
          prsCreated: maintPrs.length,
          prsMerged: maintPrs.filter((p) => p!.status === "merged").length,
          acceptancePct: pct(
            maintPrs.filter((p) => p!.status === "merged").length,
            maintPrs.length,
          ),
          inProgress: maintTasks.filter(
            (t) => !["completed", "failed", "cancelled"].includes(t.status),
          ).length,
        },
        queue: open
          .filter((f) => f.status === "open")
          .sort((a, b) => rank[a.riskBand] - rank[b.riskBand])
          .slice(0, 10)
          .map((f) => findingListItem(db, f)),
      };
    },
  },
  {
    method: "GET",
    path: "/dependencies",
    auth: "member",
    summary: "Dependency inventory. ?repositoryId= &q= &filter=outdated|vulnerable",
    response: z.array(
      S.DependencySchema.extend({
        repositoryName: z.string(),
        outdated: z.boolean(),
        vulnerable: z.boolean(),
        majorBehind: z.boolean(),
      }),
    ),
    handler: (ctx) => {
      const q = (ctx.query.get("q") ?? "").toLowerCase();
      const f = ctx.query.get("filter");
      return inOrg(ctx.db.dependencies, ctx.orgId)
        .filter(
          (d) => !ctx.query.get("repositoryId") || d.repositoryId === ctx.query.get("repositoryId"),
        )
        .filter((d) => !q || d.name.toLowerCase().includes(q))
        .map((d) => ({
          ...d,
          repositoryName: ctx.db.repositories.find((r) => r.id === d.repositoryId)!.fullName,
          outdated: d.installedVersion !== d.latestVersion,
          majorBehind: d.installedVersion.split(".")[0] !== d.latestVersion.split(".")[0],
          vulnerable: ctx.db.findings.some(
            (x) =>
              x.dependencyId === d.id && x.category === "vulnerability" && x.status !== "resolved",
          ),
        }))
        .filter((d) => !f || (f === "outdated" ? d.outdated : d.vulnerable));
    },
  },
  {
    method: "GET",
    path: "/findings",
    auth: "member",
    summary: "Maintenance findings. ?status= &severity= &category= &repositoryId=",
    response: z.array(S.FindingListItemSchema),
    handler: (ctx) => {
      const q = ctx.query;
      const rank = { urgent: 0, high: 1, medium: 2, low: 3 };
      return inOrg(ctx.db.findings, ctx.orgId)
        .filter(
          (f) =>
            (!q.get("status") || q.get("status")!.split(",").includes(f.status)) &&
            (!q.get("severity") || f.severity === q.get("severity")) &&
            (!q.get("category") || f.category === q.get("category")) &&
            (!q.get("repositoryId") || f.repositoryId === q.get("repositoryId")),
        )
        .sort(
          (a, b) => rank[a.riskBand] - rank[b.riskBand] || b.detectedAt.localeCompare(a.detectedAt),
        )
        .map((f) => findingListItem(ctx.db, f));
    },
  },
  {
    method: "GET",
    path: "/findings/:id",
    auth: "member",
    summary: "Finding detail with advisory evidence, dependency and linked task.",
    response: S.FindingDetailSchema,
    handler: (ctx) => {
      const f = own(ctx, ctx.db.findings, ctx.params.id, "Finding");
      const t = f.taskId ? ctx.db.tasks.find((x) => x.id === f.taskId) : undefined;
      return {
        finding: findingListItem(ctx.db, f),
        dependency: f.dependencyId
          ? (ctx.db.dependencies.find((d) => d.id === f.dependencyId) ?? null)
          : null,
        repository: ctx.db.repositories.find((r) => r.id === f.repositoryId)!,
        task: t ? taskListItem(ctx.db, t) : null,
        similar: inOrg(ctx.db.findings, ctx.orgId)
          .filter((x) => x.id !== f.id && x.package && x.package === f.package)
          .map((x) => findingListItem(ctx.db, x)),
      };
    },
  },
  {
    method: "POST",
    path: "/findings/:id/actions",
    auth: "finding.create_task",
    summary:
      "create_task (policy-validated DevPilot maintenance task) | suppress (reason + expiry, admins) | unsuppress.",
    request: S.FindingActionInputSchema,
    response: S.FindingDetailSchema,
    handler: (ctx) => {
      const { db, now } = ctx;
      const f = own(ctx, db.findings, ctx.params.id, "Finding");
      const input = body(S.FindingActionInputSchema, ctx.body);
      if (input.action === "create_task") {
        if (f.taskId)
          throw new HttpError(409, "A maintenance task already exists for this finding");
        const agentId =
          input.agentId ?? inOrg(db.agents, ctx.orgId).find((a) => a.status === "active")?.id;
        if (!agentId) throw new HttpError(409, "No active agent runtime");
        const task = createTask(ctx, {
          repositoryId: f.repositoryId,
          title:
            f.package && f.fixedVersion
              ? `Upgrade ${f.package} to ${f.fixedVersion}`
              : `Maintenance: ${f.title}`,
          description: `CodeKeeper finding ${f.id}${f.advisoryId ? ` (${f.advisoryId}, ${f.advisorySource})` : ""}: ${f.title}. Evidence: ${f.evidence}`,
          acceptanceCriteria:
            f.package && f.fixedVersion
              ? [
                  `${f.package} ≥ ${f.fixedVersion}`,
                  "All ShipSafe checks pass",
                  "Rollback notes in the PR description",
                ]
              : ["Finding no longer detected on rescan", "All ShipSafe checks pass"],
          constraints: ["Change only what the finding requires"],
          priority: f.riskBand === "urgent" ? "urgent" : f.riskBand === "high" ? "high" : "medium",
          agentId,
          targetBranch: "main",
          budgetUsd: 4,
          timeoutMin: 30,
          launch: true,
          source: "codekeeper_finding",
          findingId: f.id,
        });
        f.taskId = task.id;
        f.status = "task_created";
        audit(db, ctx.orgId, person(ctx), "finding.task_created", `finding:${f.id}`, task.id, now);
      } else if (input.action === "suppress") {
        require(ctx, "finding.suppress");
        const max = policy(ctx).suppressionMaxDays;
        if (input.expiresInDays > max)
          throw new HttpError(422, `Suppressions can last at most ${max} days by policy`);
        f.status = "suppressed";
        f.suppression = {
          reason: input.reason,
          by: me(ctx).id,
          at: toIso(now),
          expiresAt: toIso(now + input.expiresInDays * DAY),
        };
        audit(
          db,
          ctx.orgId,
          person(ctx),
          "finding.suppressed",
          `finding:${f.id}`,
          input.reason,
          now,
        );
      } else {
        require(ctx, "finding.suppress");
        f.status = "open";
        f.suppression = null;
      }
      return routes.find((r) => r.path === "/findings/:id")!.handler(ctx);
    },
  },

  // ===== approvals
  {
    method: "GET",
    path: "/approvals",
    auth: "member",
    summary: "Approval centre. ?status=",
    response: z.array(
      S.ApprovalSchema.extend({
        requesterResolved: S.ResolvedActorSchema,
        taskTitle: z.string().nullable(),
        canDecide: z.boolean(),
      }),
    ),
    handler: (ctx) =>
      inOrg(ctx.db.approvals, ctx.orgId)
        .filter((a) => !ctx.query.get("status") || a.status === ctx.query.get("status"))
        .sort(
          (a, b) =>
            (a.status === "pending" ? -1 : 0) - (b.status === "pending" ? -1 : 0) ||
            b.requestedAt.localeCompare(a.requestedAt),
        )
        .map((a) => ({
          ...a,
          requesterResolved: activity(ctx.db, [
            {
              id: "x",
              orgId: a.orgId,
              actor: { type: a.requestedBy.type, id: a.requestedBy.id },
              action: "",
              resource: "",
              at: a.requestedAt,
              detail: "",
              ip: null,
            },
          ])[0].actorResolved,
          taskTitle:
            typeof a.context.taskId === "string"
              ? (ctx.db.tasks.find((t) => t.id === a.context.taskId)?.title ?? null)
              : null,
          canDecide:
            a.status === "pending" &&
            meetsRole(ctx.role, a.approverRole) &&
            !(a.requestedBy.type === "person" && a.requestedBy.id === me(ctx).id),
        })),
  },
  {
    method: "POST",
    path: "/approvals/:id/decision",
    auth: "approval.decide",
    summary:
      "Approve or reject. Bound to the exact action and context; requester can't approve their own request.",
    request: S.ApprovalDecisionInputSchema,
    response: S.ApprovalSchema,
    handler: (ctx) => {
      const { db, now } = ctx;
      const a = own(ctx, db.approvals, ctx.params.id, "Approval");
      if (a.status !== "pending") throw new HttpError(409, "This request was already decided");
      if (Date.parse(a.expiresAt) < now) {
        a.status = "expired";
        throw new HttpError(409, "This request expired");
      }
      if (!meetsRole(ctx.role, a.approverRole))
        throw new HttpError(403, `Needs ${a.approverRole} or above`);
      if (a.requestedBy.type === "person" && a.requestedBy.id === me(ctx).id)
        throw new HttpError(403, "You can't approve your own request");
      const input = body(S.ApprovalDecisionInputSchema, ctx.body);
      a.status = input.decision;
      a.decidedBy = me(ctx).id;
      a.decidedAt = toIso(now);
      a.comment = input.comment || null;
      audit(
        db,
        ctx.orgId,
        person(ctx),
        `approval.${input.decision}`,
        `approval:${a.id}`,
        a.title,
        now,
      );
      const s =
        typeof a.context.sessionId === "string"
          ? db.sessions.find((x) => x.id === a.context.sessionId)
          : undefined;
      if (s && s.status === "waiting") {
        if (input.decision === "approved") resumeSession(db, s, now);
        else
          endSession(
            db,
            s,
            "failed",
            `Stopped: ${me(ctx).name} rejected "${a.title}"${input.comment ? ` — ${input.comment}` : ""}`,
            now,
          );
      }
      if (a.action === "budget_increase" && input.decision === "approved") {
        const o = org(ctx);
        o.budget.monthlyLimitUsd = Number(a.context.requestedUsd ?? o.budget.monthlyLimitUsd);
      }
      return a;
    },
  },
  {
    method: "POST",
    path: "/sessions/:id/input",
    auth: "task.launch",
    summary: "Answer an agent's clarification question and resume the session.",
    request: S.SessionInputSchema,
    response: S.SessionListItemSchema,
    handler: (ctx) => {
      const s = own(ctx, ctx.db.sessions, ctx.params.id, "Session");
      if (s.status !== "waiting" || s.waitingFor?.kind !== "clarification")
        throw new HttpError(409, "The session isn't waiting for an answer");
      const { answer } = body(S.SessionInputSchema, ctx.body);
      s.notes = `${s.notes ? s.notes + " · " : ""}Answer: ${answer}`;
      resumeSession(ctx.db, s, ctx.now);
      return sessionListItem(ctx.db, s);
    },
  },

  // ===== analytics
  {
    method: "GET",
    path: "/analytics",
    auth: "member",
    summary:
      "Analytics (30/90 days): North Star, task success by type, providers (task-mix caveat), PR acceptance, test usefulness, cost per verified task.",
    response: S.AnalyticsSchema,
    handler: (ctx) => {
      const { db, now, orgId } = ctx;
      const range = Number(ctx.query.get("range") ?? 30) === 90 ? 90 : 30;
      const from = now - range * DAY;
      const tasks = inOrg(db.tasks, orgId).filter((t) => Date.parse(t.createdAt) > from);
      const sessions = inOrg(db.sessions, orgId).filter((s) => Date.parse(s.startedAt) > from);
      const cat = (t: Task) =>
        t.source === "shipsafe_failure"
          ? "Bug fix"
          : t.source === "codekeeper_finding"
            ? "Maintenance"
            : /test/i.test(t.title)
              ? "Tests"
              : /fix/i.test(t.title)
                ? "Bug fix"
                : "Feature";
      const cats = [...new Set(tasks.map(cat))];
      const prs = inOrg(db.pullRequests, orgId).filter((p) => Date.parse(p.openedAt) > from);
      const closed = (type: "agent" | "person") =>
        prs.filter((p) => p.author.type === type && p.status !== "open");
      const results = db.testResults.filter(
        (r) =>
          inOrg(db.testRuns, orgId).some((x) => x.id === r.runId) &&
          r.classification &&
          r.classification !== "flaky",
      );
      const bugs = inOrg(db.bugs, orgId);
      const verified = verifiedTasks(db, orgId, from, now + 1);
      const verifyDur = inOrg(db.testRuns, orgId)
        .filter((r) => r.pullRequestId && r.durationSec)
        .map((r) => r.durationSec! / 60)
        .sort((a, b) => a - b);
      const days = Array.from({ length: range }, (_, i) =>
        toIso(now - (range - 1 - i) * DAY).slice(0, 10),
      );
      const providers = [...new Set(inOrg(db.agents, orgId).map((a) => a.provider))];
      return {
        rangeDays: range,
        northStar: Array.from({ length: Math.round(range / 7) }, (_, i) => {
          const end = now - (Math.round(range / 7) - 1 - i) * 7 * DAY;
          return {
            date: toIso(end).slice(0, 10),
            value: verifiedTasks(db, orgId, end - 7 * DAY, end + 1).length,
          };
        }),
        taskSuccessByType: cats.map((c) => {
          const ts = tasks.filter((t) => cat(t) === c);
          const ended = ts.filter((t) =>
            ["review_ready", "completed", "failed"].includes(t.status),
          );
          const ss = sessions.filter((s) => ts.some((t) => t.id === s.taskId));
          return {
            category: c,
            tasks: ts.length,
            successPct: pct(ended.filter((t) => t.status !== "failed").length, ended.length),
            avgCostUsd: ss.length
              ? Math.round((ss.reduce((s, x) => s + x.costUsd, 0) / Math.max(1, ts.length)) * 100) /
                100
              : 0,
            reworkPct: pct(
              ts.filter(
                (t) =>
                  db.sessions.filter((s) => s.taskId === t.id).length > 1 ||
                  db.tasks.some((x) => x.parentTaskId === t.id),
              ).length,
              ts.length,
            ),
          };
        }),
        providers: providers.map((p) => {
          const ss = sessions.filter(
            (s) => db.agents.find((a) => a.id === s.agentId)?.provider === p,
          );
          const ended = ss.filter((s) => s.endedAt);
          return {
            provider: p,
            sessions: ss.length,
            successPct: pct(ended.filter((s) => s.status === "completed").length, ended.length),
            avgMinutes: ended.length
              ? Math.round(
                  ended.reduce(
                    (s, x) => s + (Date.parse(x.endedAt!) - Date.parse(x.startedAt)) / 60_000,
                    0,
                  ) / ended.length,
                )
              : 0,
            costUsd: Math.round(ss.reduce((s, x) => s + x.costUsd, 0) * 100) / 100,
            humanInterventions: db.approvals.filter((a) =>
              ss.some((s) => s.id === a.context.sessionId),
            ).length,
          };
        }),
        prAcceptance: {
          agentPct: pct(
            closed("agent").filter((p) => p.status === "merged").length,
            closed("agent").length,
          ),
          humanPct: pct(
            closed("person").filter((p) => p.status === "merged").length,
            closed("person").length,
          ),
          agentMerged: closed("agent").filter((p) => p.status === "merged").length,
          humanMerged: closed("person").filter((p) => p.status === "merged").length,
        },
        testUsefulness: {
          actionablePct: pct(
            bugs.filter((b) => b.status !== "wont_fix").length,
            Math.max(1, results.length),
          ),
          reported: results.length,
          falsePositive: bugs.filter((b) => b.status === "wont_fix").length,
        },
        timeToVerifyMinP50: verifyDur.length
          ? Math.round(verifyDur[Math.floor(verifyDur.length / 2)] * 10) / 10
          : 0,
        costPerVerifiedTaskUsd: verified.length
          ? Math.round((spendBetween(db, orgId, from, now + DAY) / verified.length) * 100) / 100
          : 0,
        spendByDay: days.map((d) => {
          const us = inOrg(db.usageRecords, orgId).filter((u) => u.date === d);
          return {
            date: d,
            agentUsd:
              Math.round(
                us.filter((u) => u.meter === "agent_minutes").reduce((s, u) => s + u.costUsd, 0) *
                  100,
              ) / 100,
            browserUsd:
              Math.round(
                us.filter((u) => u.meter === "browser_minutes").reduce((s, u) => s + u.costUsd, 0) *
                  100,
              ) / 100,
          };
        }),
      };
    },
  },

  // ===== integrations
  {
    method: "GET",
    path: "/integrations",
    auth: "member",
    summary: "Integration catalogue merged with this workspace's connections.",
    response: z.array(S.IntegrationViewSchema),
    handler: (ctx) =>
      INTEGRATION_PROVIDERS.map((p) => ({
        providerId: p.id,
        name: p.name,
        category: p.category,
        description: p.description,
        availability: p.availability,
        scopes: p.scopes,
        monogram: p.monogram,
        connection:
          ctx.db.integrations.find((i) => i.orgId === ctx.orgId && i.providerId === p.id) ?? null,
      })),
  },
  {
    method: "POST",
    path: "/integrations/:providerId/connect",
    auth: "integration.manage",
    summary:
      "Connect (mock OAuth / API key) an integration. Credentials live in the vault; only a reference is stored.",
    request: S.ConnectIntegrationInputSchema,
    response: S.IntegrationSchema,
    prepare: async (ctx) => {
      const { credentials } = body(CredentialInputSchema, ctx.body);
      if (!credentials) return null;
      const checked = await ctx.ports.credentials.verify(ctx.params.providerId, credentials);
      return { credentials, account: checked.account };
    },
    handler: async (ctx) => {
      const p = providerById(ctx.params.providerId);
      if (!p) throw new HttpError(404, "Unknown integration");
      if (p.availability === "coming_soon") throw new HttpError(409, `${p.name} is coming soon`);
      if (p.availability === "enterprise" && org(ctx).plan !== "enterprise")
        throw new HttpError(402, `${p.name} requires the Enterprise plan`);
      const input = body(S.ConnectIntegrationInputSchema, ctx.body);
      const verified = ctx.prepared as {
        credentials: Record<string, string>;
        account?: string;
      } | null;
      // Secrets go to the vault (encrypted); the integration record only says that one exists.
      if (verified) await ctx.ports.credentials.put(tx(ctx), ctx.orgId, p.id, verified.credentials);
      const account = verified?.account ?? input.account;
      let i = ctx.db.integrations.find((x) => x.orgId === ctx.orgId && x.providerId === p.id);
      if (!i) {
        i = {
          id: newId("int"),
          orgId: ctx.orgId,
          providerId: p.id,
          status: "connected",
          account,
          connectedAt: toIso(ctx.now),
          scopes: p.scopes,
        };
        ctx.db.integrations.push(i);
      } else
        Object.assign(i, {
          status: "connected",
          account,
          connectedAt: toIso(ctx.now),
          error: undefined,
        });
      if (
        (p.id === "claude_code" || p.id === "openai_codex") &&
        !inOrg(ctx.db.agents, ctx.orgId).some((a) => a.provider === p.id)
      ) {
        ctx.db.agents.push({
          id: newId("agent"),
          orgId: ctx.orgId,
          provider: p.id,
          name: p.name,
          model: p.id === "claude_code" ? "claude-sonnet" : "codex",
          status: "active",
          maxConcurrent: 2,
          defaultTimeoutMin: 45,
          defaultBudgetUsd: 6,
        });
        const pol = policy(ctx);
        if (!pol.allowedProviders.includes(p.id)) pol.allowedProviders.push(p.id);
      }
      audit(
        ctx.db,
        ctx.orgId,
        person(ctx),
        "integration.connected",
        `integration:${p.id}`,
        account,
        ctx.now,
      );
      return i;
    },
  },
  {
    method: "POST",
    path: "/integrations/:providerId/disconnect",
    auth: "integration.manage",
    summary: "Disconnect and revoke an integration.",
    response: S.OkSchema,
    handler: async (ctx) => {
      const i = ctx.db.integrations.find(
        (x) => x.orgId === ctx.orgId && x.providerId === ctx.params.providerId,
      );
      if (i) Object.assign(i, { status: "disconnected", connectedAt: null, error: undefined });
      await ctx.ports.credentials.remove(tx(ctx), ctx.orgId, ctx.params.providerId);
      if (ctx.params.providerId === "github")
        await ctx.ports.github.unlinkInstallations(tx(ctx), ctx.orgId);
      ctx.db.agents
        .filter((a) => a.orgId === ctx.orgId && a.provider === ctx.params.providerId)
        .forEach((a) => (a.status = "suspended"));
      audit(
        ctx.db,
        ctx.orgId,
        person(ctx),
        "integration.disconnected",
        `integration:${ctx.params.providerId}`,
        "",
        ctx.now,
      );
      return { ok: true };
    },
  },

  // ===== settings: workspace, members, policy, api keys, audit
  {
    method: "POST",
    path: "/workspace",
    auth: "workspace.manage",
    summary: "Rename the workspace.",
    request: S.WorkspacePatchSchema,
    response: S.OrganizationSchema,
    handler: (ctx) => Object.assign(org(ctx), body(S.WorkspacePatchSchema, ctx.body)),
  },
  {
    method: "GET",
    path: "/members",
    auth: "member",
    summary: "Members, pending invitations and seats.",
    response: S.MembersSchema,
    handler: (ctx) => ({
      members: ctx.db.memberships
        .filter((m) => m.orgId === ctx.orgId)
        .map((m) => {
          const u = ctx.db.users.find((x) => x.id === m.userId)!;
          const last = ctx.db.auditLogs.find(
            (l) => l.orgId === ctx.orgId && l.actor.type === "person" && l.actor.id === u.id,
          );
          return { ...u, role: m.role, joinedAt: m.joinedAt, lastActiveAt: last?.at ?? null };
        }),
      invitations: inOrg(ctx.db.invitations, ctx.orgId).filter((i) => i.status === "pending"),
      seatsPurchased: org(ctx).seatsPurchased,
      seatsIncluded: planById(org(ctx).plan).limits.seats,
    }),
  },
  {
    method: "POST",
    path: "/members/invite",
    auth: "member.manage",
    summary: "Invite a member (respects the plan's seat limit).",
    request: S.InviteInputSchema,
    response: S.InvitationSchema,
    handler: async (ctx) => {
      const input = body(S.InviteInputSchema, ctx.body);
      const seats = planById(org(ctx).plan).limits.seats;
      const used =
        ctx.db.memberships.filter((m) => m.orgId === ctx.orgId).length +
        inOrg(ctx.db.invitations, ctx.orgId).filter((i) => i.status === "pending").length;
      if (seats !== null && used >= seats)
        throw new HttpError(402, `All ${seats} seats are in use. Upgrade to add members.`);
      if (
        ctx.db.memberships.some(
          (m) =>
            m.orgId === ctx.orgId &&
            ctx.db.users.find((u) => u.id === m.userId)?.email.toLowerCase() ===
              input.email.toLowerCase(),
        ) ||
        inOrg(ctx.db.invitations, ctx.orgId).some(
          (i) => i.email.toLowerCase() === input.email.toLowerCase() && i.status === "pending",
        )
      )
        throw new HttpError(409, "That person is already a member or invited");
      const inv = {
        id: newId("inv"),
        orgId: ctx.orgId,
        email: input.email,
        role: input.role,
        invitedBy: me(ctx).id,
        sentAt: toIso(ctx.now),
        status: "pending" as const,
      };
      ctx.db.invitations.push(inv);
      const link = await ctx.ports.invitations.issue(tx(ctx), {
        orgId: ctx.orgId,
        invitationId: inv.id,
        email: inv.email,
      });
      fx(ctx.db).enqueue({
        kind: "email.send",
        payload: {
          to: inv.email,
          template: "invitation",
          data: { workspace: org(ctx).name, inviter: me(ctx).name, role: inv.role, link },
        },
      });
      audit(
        ctx.db,
        ctx.orgId,
        person(ctx),
        "member.invited",
        `invitation:${inv.id}`,
        `${input.email} as ${input.role}`,
        ctx.now,
      );
      return inv;
    },
  },
  {
    method: "POST",
    path: "/invitations/:id/revoke",
    auth: "member.manage",
    summary: "Revoke a pending invitation.",
    response: S.OkSchema,
    handler: async (ctx) => {
      const inv = own(ctx, ctx.db.invitations, ctx.params.id, "Invitation");
      if (inv.status !== "pending")
        throw new HttpError(409, "This invitation is no longer pending");
      inv.status = "revoked";
      await ctx.ports.invitations.revoke(tx(ctx), ctx.orgId, inv.id);
      audit(
        ctx.db,
        ctx.orgId,
        person(ctx),
        "member.invite_revoked",
        `invitation:${inv.id}`,
        inv.email,
        ctx.now,
      );
      return { ok: true };
    },
  },
  {
    method: "POST",
    path: "/members/:userId/role",
    auth: "member.manage",
    summary:
      "Change a member's role. Only owners can grant or remove owner; the last owner can't be demoted.",
    request: S.RoleChangeInputSchema,
    response: S.OkSchema,
    handler: (ctx) => {
      const { role } = body(S.RoleChangeInputSchema, ctx.body);
      const m = ctx.db.memberships.find(
        (x) => x.orgId === ctx.orgId && x.userId === ctx.params.userId,
      );
      if (!m) throw new HttpError(404, "Member not found");
      if ((role === "owner" || m.role === "owner") && ctx.role !== "owner")
        throw new HttpError(403, "Only owners can change owner roles");
      if (
        m.role === "owner" &&
        role !== "owner" &&
        ctx.db.memberships.filter((x) => x.orgId === ctx.orgId && x.role === "owner").length === 1
      )
        throw new HttpError(409, "A workspace needs at least one owner");
      m.role = role;
      audit(
        ctx.db,
        ctx.orgId,
        person(ctx),
        "member.role_changed",
        `user:${m.userId}`,
        role,
        ctx.now,
      );
      return { ok: true };
    },
  },
  {
    method: "POST",
    path: "/members/:userId/remove",
    auth: "member.manage",
    summary: "Remove a member from the workspace.",
    response: S.OkSchema,
    handler: (ctx) => {
      const m = ctx.db.memberships.find(
        (x) => x.orgId === ctx.orgId && x.userId === ctx.params.userId,
      );
      if (!m) throw new HttpError(404, "Member not found");
      if (m.role === "owner")
        throw new HttpError(409, "Transfer ownership before removing an owner");
      if (m.userId === me(ctx).id) throw new HttpError(409, "You can't remove yourself");
      ctx.db.memberships = ctx.db.memberships.filter((x) => x !== m);
      audit(ctx.db, ctx.orgId, person(ctx), "member.removed", `user:${m.userId}`, "", ctx.now);
      return { ok: true };
    },
  },
  {
    method: "GET",
    path: "/policy",
    auth: "member",
    summary:
      "Workspace policies: providers, protected paths, network, required checks, approval rules, retention.",
    response: S.PolicySchema,
    handler: (ctx) => policy(ctx),
  },
  {
    method: "POST",
    path: "/policy",
    auth: "policy.manage",
    summary: "Update workspace policies (Team plan and above).",
    request: S.PolicyPatchSchema,
    response: S.PolicySchema,
    handler: (ctx) => {
      const p = policy(ctx);
      Object.assign(p, body(S.PolicyPatchSchema, ctx.body));
      audit(ctx.db, ctx.orgId, person(ctx), "policy.updated", "policy", "", ctx.now);
      return p;
    },
  },
  {
    method: "GET",
    path: "/api-keys",
    auth: "member",
    summary: "API keys (prefix only; secrets are shown once at creation).",
    response: z.array(S.ApiKeySchema),
    handler: (ctx) => inOrg(ctx.db.apiKeys, ctx.orgId),
  },
  {
    method: "POST",
    path: "/api-keys",
    auth: "apikey.manage",
    summary: "Create an API key. The secret is returned once.",
    request: S.ApiKeyInputSchema,
    response: S.ApiKeyCreatedSchema,
    handler: async (ctx) => {
      const input = body(S.ApiKeyInputSchema, ctx.body);
      // 192 bits from the CSPRNG. Only a SHA-256 of it is stored; it cannot be shown again.
      const secret = `fp_live_${randomToken(24).replace(/[^A-Za-z0-9]/g, "x")}`;
      const key = {
        id: newId("key"),
        orgId: ctx.orgId,
        name: input.name,
        prefix: secret.slice(0, 12),
        scopes: input.scopes,
        createdBy: me(ctx).id,
        createdAt: toIso(ctx.now),
        lastUsedAt: null,
      };
      ctx.db.apiKeys.push(key);
      await ctx.ports.apiKeys.register(tx(ctx), {
        orgId: ctx.orgId,
        keyId: key.id,
        secret,
        createdBy: key.createdBy,
        // A key can never do more than the person who created it could at that moment.
        role: ctx.role!,
      });
      audit(
        ctx.db,
        ctx.orgId,
        person(ctx),
        "apikey.created",
        `apikey:${key.id}`,
        key.name,
        ctx.now,
      );
      return { key, secret };
    },
  },
  {
    method: "POST",
    path: "/api-keys/:id/revoke",
    auth: "apikey.manage",
    summary: "Revoke an API key immediately.",
    response: S.OkSchema,
    handler: async (ctx) => {
      const k = own(ctx, ctx.db.apiKeys, ctx.params.id, "API key");
      ctx.db.apiKeys = ctx.db.apiKeys.filter((x) => x !== k);
      await ctx.ports.apiKeys.revoke(tx(ctx), ctx.orgId, k.id);
      audit(ctx.db, ctx.orgId, person(ctx), "apikey.revoked", `apikey:${k.id}`, k.name, ctx.now);
      return { ok: true };
    },
  },
  {
    method: "GET",
    path: "/audit-logs",
    auth: "member",
    summary: "Audit log of user, agent and system actions. ?actorType= &q= &limit=",
    response: z.array(S.ActivityItemSchema),
    handler: (ctx) => {
      const q = (ctx.query.get("q") ?? "").toLowerCase();
      const type = ctx.query.get("actorType");
      return activity(
        ctx.db,
        inOrg(ctx.db.auditLogs, ctx.orgId)
          .filter(
            (l) =>
              (!type || l.actor.type === type) &&
              (!q ||
                l.action.includes(q) ||
                l.detail.toLowerCase().includes(q) ||
                l.resource.includes(q)),
          )
          .slice(0, Number(ctx.query.get("limit") ?? 200)),
      );
    },
  },

  // ===== billing
  {
    method: "GET",
    path: "/plans",
    auth: "public",
    summary: "Public plan catalogue (pricing page).",
    response: z.array(S.PlanSchema),
    handler: () => PLANS,
  },
  {
    method: "GET",
    path: "/billing",
    auth: "member",
    summary: "Plan, metered usage vs quota, projected spend, budget, cost breakdowns and invoices.",
    response: S.BillingSchema,
    prepare: paymentMethod,
    handler: billing,
  },
  {
    method: "POST",
    path: "/billing/plan",
    auth: "billing.manage",
    summary: "Change plan or billing cycle (mock checkout). Enterprise is sales-assisted.",
    request: S.ChangePlanInputSchema,
    response: S.BillingSchema,
    prepare: async (ctx) => {
      if (!ctx.ports.stripeLive) return null;
      const { input, seatsUsed } = validatePlanChange(ctx);
      // Stripe first: the workspace only changes plan once the subscription did.
      await ctx.ports.billing.changePlan({
        org: org(ctx),
        plan: input.plan,
        billingCycle: input.billingCycle,
        userEmail: me(ctx).email,
        seats: seatsUsed,
      });
      return paymentMethod(ctx);
    },
    handler: (ctx) => {
      // Without Stripe a plan change is only a simulation, which is fine for the demo and nowhere else.
      if (!ctx.ports.stripeLive && !ctx.ports.demoMode)
        throw new HttpError(
          409,
          "Billing is not set up for this environment yet, so plans can't be changed.",
        );
      const { input, target } = validatePlanChange(ctx);
      const o = org(ctx);
      o.plan = input.plan;
      o.billingCycle = input.billingCycle;
      o.trialEndsAt = null;
      audit(
        ctx.db,
        ctx.orgId,
        person(ctx),
        "billing.plan_changed",
        "billing",
        `${target.name} (${input.billingCycle})`,
        ctx.now,
      );
      return billing(ctx);
    },
  },
  {
    method: "POST",
    path: "/billing/budget",
    auth: "billing.manage",
    summary: "Set the monthly execution budget, hard cap and alert thresholds.",
    request: S.BudgetInputSchema,
    response: S.BillingSchema,
    prepare: paymentMethod,
    handler: (ctx) => {
      org(ctx).budget = body(S.BudgetInputSchema, ctx.body);
      audit(
        ctx.db,
        ctx.orgId,
        person(ctx),
        "billing.budget_updated",
        "billing",
        `$${org(ctx).budget.monthlyLimitUsd}`,
        ctx.now,
      );
      return billing(ctx);
    },
  },

  // ===== notifications, search, demo
  {
    method: "GET",
    path: "/notifications",
    auth: "member",
    summary: "Notifications for the active workspace.",
    response: z.array(S.NotificationSchema),
    handler: (ctx) =>
      inOrg(ctx.db.notifications, ctx.orgId).sort((a, b) => b.at.localeCompare(a.at)),
  },
  {
    method: "POST",
    path: "/notifications/read",
    auth: "member",
    summary: "Mark notifications read. Body { ids?: string[] }.",
    request: z.object({ ids: z.array(z.string()).optional() }),
    response: S.OkSchema,
    handler: (ctx) => {
      const { ids } = body(z.object({ ids: z.array(z.string()).optional() }), ctx.body);
      inOrg(ctx.db.notifications, ctx.orgId).forEach(
        (n) => (!ids || ids.includes(n.id)) && (n.read = true),
      );
      return { ok: true };
    },
  },
  {
    method: "GET",
    path: "/search",
    auth: "member",
    summary: "Search projects, repositories, tasks, PRs, bugs, findings and sessions. ?q=",
    response: z.array(S.SearchResultSchema),
    handler: (ctx) => {
      const { db, orgId } = ctx;
      const q = (ctx.query.get("q") ?? "").trim().toLowerCase();
      const hit = (...s: (string | null | undefined)[]) =>
        !q || s.some((x) => x?.toLowerCase().includes(q));
      const out: S.SearchResult[] = [];
      inOrg(db.projects, orgId)
        .filter((p) => hit(p.name))
        .forEach((p) =>
          out.push({
            kind: "project",
            id: p.id,
            title: p.name,
            subtitle: p.description,
            href: `/app/projects/${p.id}`,
          }),
        );
      inOrg(db.repositories, orgId)
        .filter((r) => hit(r.fullName))
        .forEach((r) =>
          out.push({
            kind: "repository",
            id: r.id,
            title: r.fullName,
            subtitle: r.frameworks.join(", "),
            href: `/app/repositories/${r.id}`,
          }),
        );
      inOrg(db.tasks, orgId)
        .filter((t) => hit(t.title, t.id, t.sourceRef))
        .forEach((t) =>
          out.push({
            kind: "task",
            id: t.id,
            title: t.title,
            subtitle: `${t.id} · ${t.status.replace("_", " ")}`,
            href: `/app/devpilot/tasks/${t.id}`,
          }),
        );
      inOrg(db.pullRequests, orgId)
        .filter((p) => hit(p.title, `#${p.number}`, String(p.number)))
        .forEach((p) =>
          out.push({
            kind: "pull_request",
            id: p.id,
            title: `#${p.number} ${p.title}`,
            subtitle: db.repositories.find((r) => r.id === p.repositoryId)!.fullName,
            href: `/app/pull-requests/${p.id}`,
          }),
        );
      inOrg(db.bugs, orgId)
        .filter((b) => hit(b.title))
        .forEach((b) =>
          out.push({
            kind: "bug",
            id: b.id,
            title: b.title,
            subtitle: b.severity,
            href: `/app/shipsafe/bugs/${b.id}`,
          }),
        );
      inOrg(db.findings, orgId)
        .filter((f) => q && hit(f.title, f.advisoryId, f.package))
        .forEach((f) =>
          out.push({
            kind: "finding",
            id: f.id,
            title: f.title,
            subtitle: f.advisoryId ?? f.category,
            href: `/app/codekeeper/findings?finding=${f.id}`,
          }),
        );
      return out.slice(0, 50);
    },
  },
];
