/**
 * Read models: raw entities → API response shapes (lib/schemas/api.ts).
 * Every number is computed from mock data — nothing is hard-coded.
 */
import type { TenantState } from "../tenancy/state";
import type {
  ActivityItem,
  ActorRef,
  AuditLog,
  BugListItem,
  FindingListItem,
  LifecycleStep,
  PolicyCheck,
  ProjectSummary,
  PullRequest,
  PullRequestListItem,
  RepositorySummary,
  ResolvedActor,
  SessionListItem,
  Task,
  TaskListItem,
  TestRun,
  TestRunListItem,
} from "../contract/schemas";
import { PROVIDER_LABEL } from "../contract/domain/labels";

const DAY = 86_400_000;

// ---------------------------------------------------------------- actors & activity
const SYSTEM: Record<string, [string, string]> = {
  shipsafe: ["ShipSafe", "Verification"],
  codekeeper: ["CodeKeeper", "Maintenance"],
  devpilot: ["DevPilot", "Orchestration"],
  integrations: ["Integrations", "System"],
  billing: ["Billing", "System"],
  github: ["GitHub", "Webhook"],
};

export function resolveActor(db: TenantState, actor: ActorRef): ResolvedActor {
  if (actor.type === "person") {
    const u = db.users.find((x) => x.id === actor.id);
    return { type: "person", id: actor.id, name: u?.name ?? actor.id, detail: u?.title ?? "" };
  }
  if (actor.type === "agent") {
    const a = db.agents.find((x) => x.id === actor.id);
    return { type: "agent", id: actor.id, name: a?.name ?? actor.id, detail: a?.model ?? "" };
  }
  const [name, detail] = SYSTEM[actor.id] ?? [actor.id, "System"];
  return { type: "system", id: actor.id, name, detail };
}

const ACTION_LABEL: Record<string, string> = {
  "task.created": "created a task",
  "task.launched": "launched an agent on",
  "task.retried": "retried",
  "task.cancelled": "cancelled",
  "agent.session_started": "started a session",
  "agent.session_completed": "finished a session",
  "agent.session_failed": "session failed",
  "agent.session_cancelled": "session cancelled",
  "pull_request.opened": "opened a pull request",
  "pull_request.synchronize": "pushed a new commit",
  "pull_request.merged": "merged in GitHub",
  "pull_request.reviewed": "reviewed",
  "test_run.started": "started verification",
  "test.passed": "verification passed",
  "test.failed": "verification failed",
  "bug.created": "filed a bug",
  "bug.resolved": "resolved a bug",
  "approval.requested": "requested approval",
  "approval.approved": "approved",
  "approval.rejected": "rejected",
  "scan.started": "started a scan",
  "scan.completed": "completed a scan",
  "finding.suppressed": "suppressed a finding",
  "finding.task_created": "created a maintenance task",
  "member.invited": "invited a member",
  "member.role_changed": "changed a role",
  "policy.updated": "updated policies",
  "integration.connected": "connected an integration",
  "integration.disconnected": "disconnected an integration",
  "integration.error": "integration error",
  "billing.plan_changed": "changed the plan",
  "billing.budget_updated": "updated the budget",
  "apikey.created": "created an API key",
  "apikey.revoked": "revoked an API key",
  "repository.connected": "connected a repository",
};

export function hrefForResource(resource: string): string | null {
  const [kind, id] = resource.split(":");
  if (!id) return null;
  return (
    (
      {
        task: `/app/devpilot/tasks/${id}`,
        session: `/app/devpilot/sessions/${id}`,
        pr: `/app/pull-requests/${id}`,
        run: `/app/shipsafe/runs/${id}`,
        bug: `/app/shipsafe/bugs/${id}`,
        approval: "/app/approvals",
        repo: `/app/repositories/${id}`,
        finding: `/app/codekeeper/findings?finding=${id}`,
      } as Record<string, string>
    )[kind] ?? null
  );
}

export function activity(db: TenantState, logs: AuditLog[]): ActivityItem[] {
  return logs.map((l) => ({
    ...l,
    actorResolved: resolveActor(db, l.actor),
    label: ACTION_LABEL[l.action] ?? l.action.replace(/[._]/g, " "),
    href: hrefForResource(l.resource),
  }));
}

// ---------------------------------------------------------------- helpers
export const inOrg = <T extends { orgId: string }>(xs: T[], orgId: string) =>
  xs.filter((x) => x.orgId === orgId);

function repoOf(db: TenantState, id: string) {
  return db.repositories.find((r) => r.id === id)!;
}

export function failureClasses(db: TenantState, runId: string) {
  const out: Record<string, number> = {};
  db.testResults
    .filter((r) => r.runId === runId && r.classification)
    .forEach((r) => (out[r.classification!] = (out[r.classification!] ?? 0) + 1));
  return out;
}

export function runListItem(db: TenantState, run: TestRun): TestRunListItem {
  const pr = run.pullRequestId
    ? db.pullRequests.find((p) => p.id === run.pullRequestId)
    : undefined;
  return {
    ...run,
    repositoryName: repoOf(db, run.repositoryId).fullName,
    pullRequestNumber: pr?.number ?? null,
    pullRequestTitle: pr?.title ?? null,
    failureClasses: failureClasses(db, run.id),
  };
}

export function releasePolicy(db: TenantState, pr: PullRequest): PolicyCheck[] {
  const policy = db.policies.find((p) => p.orgId === pr.orgId);
  const run = pr.latestRunId ? db.testRuns.find((r) => r.id === pr.latestRunId) : undefined;
  const suites = db.testSuites.filter((s) => s.repositoryId === pr.repositoryId);
  const results = run ? db.testResults.filter((r) => r.runId === run.id) : [];
  const checks: PolicyCheck[] = suites
    .filter((s) => s.enabled)
    .map((s) => {
      const rs = results.filter((r) => r.suiteId === s.id);
      const failed = rs.some((r) => r.outcome === "failed");
      const status: PolicyCheck["status"] =
        !run || run.status === "running" || run.status === "queued"
          ? "pending"
          : run.status === "errored"
            ? "pending"
            : failed
              ? "failed"
              : rs.length
                ? "passed"
                : run.status === "failed"
                  ? "failed"
                  : "passed";
      return {
        name: `ShipSafe / ${s.type === "playwright" ? "e2e" : s.type}`,
        required: s.required,
        status,
        detail: `${s.name} · ${rs.filter((r) => r.outcome === "passed").length}/${rs.length || s.testCount} passed`,
      };
    });
  const openBugs = db.bugs.filter(
    (b) => b.pullRequestId === pr.id && (b.status === "open" || b.status === "fix_in_progress"),
  ).length;
  const visuals = db.visualSnapshots.filter((v) => v.runId === run?.id);
  if (visuals.length) {
    const pending = visuals.filter((v) => v.status === "changed").length;
    const rejected = visuals.filter((v) => v.status === "rejected").length;
    checks.push({
      name: "Visual changes approved",
      required: true,
      status: rejected ? "failed" : pending ? "pending" : "passed",
      detail: rejected
        ? `${rejected} visual change(s) rejected`
        : pending
          ? `${pending} screenshot(s) changed — approve the new baseline or reject`
          : `${visuals.length} screenshots match or were approved`,
    });
  }
  checks.push({
    name: "No open product defects",
    required: true,
    status: openBugs ? "failed" : run?.status === "running" ? "pending" : "passed",
    detail: openBugs ? `${openBugs} open bug(s) linked to this PR` : "No linked defects",
  });
  checks.push({
    name: "Human review",
    required: policy?.requirePrApproval ?? true,
    status:
      pr.reviewState === "approved"
        ? "passed"
        : pr.reviewState === "changes_requested"
          ? "failed"
          : "pending",
    detail:
      pr.reviewState === "approved"
        ? "Approved in GitHub"
        : "Waiting for a reviewer. Passing checks never merge automatically.",
  });
  return checks;
}

export function prListItem(db: TenantState, pr: PullRequest): PullRequestListItem {
  const latestRun = pr.latestRunId
    ? (db.testRuns.find((r) => r.id === pr.latestRunId) ?? null)
    : null;
  const policy = releasePolicy(db, pr);
  return {
    ...pr,
    repositoryName: repoOf(db, pr.repositoryId).fullName,
    authorResolved: resolveActor(db, { type: pr.author.type, id: pr.author.id }),
    taskTitle: pr.taskId ? (db.tasks.find((t) => t.id === pr.taskId)?.title ?? null) : null,
    latestRun,
    openBugs: db.bugs.filter(
      (b) => b.pullRequestId === pr.id && b.status !== "resolved" && b.status !== "wont_fix",
    ).length,
    requiredChecksMet: policy
      .filter((c) => c.required && c.name !== "Human review")
      .every((c) => c.status === "passed"),
  };
}

export function taskListItem(db: TenantState, t: Task): TaskListItem {
  const repo = repoOf(db, t.repositoryId);
  const sessions = db.sessions
    .filter((s) => s.taskId === t.id)
    .sort((a, b) => a.attempt - b.attempt);
  const pr = t.pullRequestId
    ? (db.pullRequests.find((p) => p.id === t.pullRequestId) ?? null)
    : null;
  const run = pr?.latestRunId ? db.testRuns.find((r) => r.id === pr.latestRunId) : undefined;
  return {
    ...t,
    repositoryName: repo.fullName,
    projectName: db.projects.find((p) => p.id === t.projectId)?.name ?? "",
    agent: db.agents.find((a) => a.id === t.agentId) ?? null,
    createdByUser: db.users.find((u) => u.id === t.createdBy) ?? null,
    latestSession: sessions.at(-1) ?? null,
    attempts: sessions.length,
    pullRequest: pr,
    latestRunStatus: run?.status ?? null,
    costUsd: Math.round(sessions.reduce((s, x) => s + x.costUsd, 0) * 100) / 100,
    verified: (t.status === "review_ready" || t.status === "completed") && run?.status === "passed",
  };
}

export function sessionListItem(
  db: TenantState,
  s: TenantState["sessions"][number],
): SessionListItem {
  const task = db.tasks.find((t) => t.id === s.taskId)!;
  const end = s.endedAt ? Date.parse(s.endedAt) : null;
  return {
    ...s,
    taskTitle: task.title,
    repositoryName: repoOf(db, task.repositoryId).fullName,
    agent: db.agents.find((a) => a.id === s.agentId)!,
    durationSec: end ? Math.round((end - Date.parse(s.startedAt)) / 1000) : null,
    workspaceState: db.workspaces.find((w) => w.sessionId === s.id)?.state ?? null,
  };
}

export function bugListItem(db: TenantState, b: TenantState["bugs"][number]): BugListItem {
  const pr = b.pullRequestId ? db.pullRequests.find((p) => p.id === b.pullRequestId) : undefined;
  return {
    ...b,
    repositoryName: repoOf(db, b.repositoryId).fullName,
    pullRequestNumber: pr?.number ?? null,
    testName: db.testResults.find((r) => r.id === b.resultId)?.name ?? "",
    taskStatus: b.taskId ? (db.tasks.find((t) => t.id === b.taskId)?.status ?? null) : null,
  };
}

export function findingListItem(
  db: TenantState,
  f: TenantState["findings"][number],
): FindingListItem {
  const repo = repoOf(db, f.repositoryId);
  return {
    ...f,
    repositoryName: repo.fullName,
    projectName: db.projects.find((p) => p.id === repo.projectId)?.name ?? "",
    taskStatus: f.taskId ? (db.tasks.find((t) => t.id === f.taskId)?.status ?? null) : null,
  };
}

export function repositorySummary(db: TenantState, id: string): RepositorySummary {
  const r = repoOf(db, id);
  const open = db.findings.filter(
    (f) => f.repositoryId === id && (f.status === "open" || f.status === "task_created"),
  );
  const runs = db.testRuns
    .filter((x) => x.repositoryId === id)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  const hist = db.healthHistory.filter((h) => h.repositoryId === id);
  return {
    ...r,
    projectName: db.projects.find((p) => p.id === r.projectId)?.name ?? "",
    openFindings: open.length,
    criticalFindings: open.filter((f) => f.severity === "critical").length,
    suites: db.testSuites.filter((s) => s.repositoryId === id).length,
    lastRunStatus: runs[0]?.status ?? null,
    lastRunAt: runs[0]?.startedAt ?? null,
    openPrs: db.pullRequests.filter((p) => p.repositoryId === id && p.status === "open").length,
    healthDelta: hist.length > 4 ? r.health.score - hist[hist.length - 5].score : 0,
    scanRunning: db.scans.some((s) => s.repositoryId === id && s.status === "running"),
  };
}

function monthStart(now: number) {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}

/** North Star: verified tasks — linked to acceptance criteria AND a passing verification (PRD §3.3). */
export function verifiedTasks(db: TenantState, orgId: string, from: number, to: number) {
  return inOrg(db.tasks, orgId).filter((t) => {
    const item = taskListItem(db, t);
    if (!item.verified || !t.acceptanceCriteria.length) return false;
    const run = item.pullRequest?.latestRunId
      ? db.testRuns.find((r) => r.id === item.pullRequest!.latestRunId)
      : undefined;
    const at = Date.parse(run?.finishedAt ?? t.createdAt);
    return at >= from && at < to;
  });
}

export function projectSummary(db: TenantState, id: string, now = Date.now()): ProjectSummary {
  const p = db.projects.find((x) => x.id === id)!;
  const repos = db.repositories.filter((r) => r.projectId === id);
  const repoIds = new Set(repos.map((r) => r.id));
  const prs = db.pullRequests.filter((x) => repoIds.has(x.repositoryId) && x.status === "open");
  return {
    ...p,
    repositories: repos.length,
    healthScore: repos.length
      ? Math.round(repos.reduce((s, r) => s + r.health.score, 0) / repos.length)
      : null,
    openPrs: prs.length,
    failingChecks: prs.filter((x) => x.checkStatus === "failed").length,
    activeSessions: db.sessions
      .filter((s) => s.status === "running" || s.status === "waiting")
      .filter((s) => db.tasks.find((t) => t.id === s.taskId)?.projectId === id).length,
    openFindings: db.findings.filter((f) => repoIds.has(f.repositoryId) && f.status === "open")
      .length,
    verifiedThisMonth: verifiedTasks(db, p.orgId, monthStart(now), now + 1).filter(
      (t) => t.projectId === id,
    ).length,
  };
}

// ---------------------------------------------------------------- lifecycle (PRD §10.1)
export function lifecycle(db: TenantState, t: Task): LifecycleStep[] {
  const pr = t.pullRequestId ? db.pullRequests.find((p) => p.id === t.pullRequestId) : undefined;
  const run = pr?.latestRunId ? db.testRuns.find((r) => r.id === pr.latestRunId) : undefined;
  const runs = pr ? db.testRuns.filter((r) => r.pullRequestId === pr.id) : [];
  const hadFailure = runs.some((r) => r.status === "failed") || !!t.bugId;
  const s = t.status;
  const step = (
    key: LifecycleStep["key"],
    label: string,
    state: LifecycleStep["state"],
    detail: string | null = null,
    href: string | null = null,
  ): LifecycleStep => ({ key, label, state, detail, href });
  const execDone =
    !["draft", "queued", "running", "waiting_input"].includes(s) && s !== "cancelled";
  return [
    step("plan", "Plan", "done", `${t.acceptanceCriteria.length} acceptance criteria`),
    step(
      "execute",
      "Execute",
      s === "running" || s === "waiting_input"
        ? "current"
        : execDone
          ? "done"
          : s === "cancelled"
            ? "failed"
            : "upcoming",
      s === "waiting_input" ? "Waiting for approval" : null,
    ),
    step(
      "propose",
      "Propose",
      pr ? "done" : s === "failed" && !pr ? "failed" : "upcoming",
      pr ? `PR #${pr.number}` : null,
      pr ? `/app/pull-requests/${pr.id}` : null,
    ),
    step(
      "verify",
      "Verify",
      !run
        ? "upcoming"
        : run.status === "running"
          ? "current"
          : run.status === "passed"
            ? "done"
            : "failed",
      run ? `ShipSafe ${run.status}` : null,
      run ? `/app/shipsafe/runs/${run.id}` : null,
    ),
    step(
      "remediate",
      "Remediate",
      hadFailure ? (run?.status === "passed" ? "done" : "current") : "skipped",
      hadFailure ? "Fix loop" : "Not needed",
    ),
    step(
      "review",
      "Review",
      s === "review_ready" ? "current" : s === "completed" ? "done" : "upcoming",
      s === "review_ready" ? "Human review in GitHub" : null,
    ),
    step(
      "merge",
      "Merge",
      s === "completed" ? "done" : "upcoming",
      s === "completed" ? "Merged in GitHub" : "GitHub is the source of truth",
    ),
    step(
      "maintain",
      "Maintain",
      s === "completed" ? "done" : "upcoming",
      s === "completed" ? "CodeKeeper rescanned" : null,
    ),
  ];
}

// ---------------------------------------------------------------- spend
export function spendBetween(db: TenantState, orgId: string, from: number, to: number) {
  return db.usageRecords
    .filter((u) => u.orgId === orgId)
    .filter((u) => {
      const d = Date.parse(u.date + "T12:00:00Z");
      return d >= from && d < to;
    })
    .reduce((s, u) => s + u.costUsd, 0);
}

export function monthToDateSpend(db: TenantState, orgId: string, now = Date.now()) {
  return Math.round(spendBetween(db, orgId, monthStart(now), now + DAY) * 100) / 100;
}

export function budgetRemaining(db: TenantState, orgId: string, now = Date.now()) {
  const org = db.organizations.find((o) => o.id === orgId)!;
  return Math.round((org.budget.monthlyLimitUsd - monthToDateSpend(db, orgId, now)) * 100) / 100;
}

export { monthStart, DAY, PROVIDER_LABEL };
