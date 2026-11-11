/**
 * The closed loop (PRD §10): DevPilot → PR → ShipSafe → bug → fix task → retest
 * → human review → merge (GitHub) → CodeKeeper.
 *
 * These functions are the only place lifecycle state changes. They are pure
 * state transitions over one workspace: API handlers, webhook processors and
 * workers all call them inside a store write, so every step is transactional
 * and leaves an audit entry.
 *
 * Execution has two modes (see `fx(db).mode`):
 *  - simulated: outcomes are generated after a short delay (demo, tests, local dev);
 *  - live: a job is enqueued for the execution plane, which reports a real outcome
 *    back through the same `complete*` functions.
 */
import type { TenantState } from "../tenancy/state";
import { fx } from "../tenancy/state";
import type {
  ActorRef,
  Bug,
  Dependency,
  Finding,
  PullRequest,
  Repository,
  Scan,
  Session,
  Task,
  TestResult,
  TestRun,
} from "../contract/schemas";
import { computeHealthScore, HEALTH_SCORE_VERSION } from "../contract/domain/health";
import { fakeSha, newId, toIso } from "./support";

type ChangedFile = Session["changedFiles"][number];

/** Per-write request metadata (client IP for the audit trail). */
const REQUEST = new WeakMap<TenantState, { ip: string | null }>();
export function bindRequest(db: TenantState, meta: { ip: string | null }) {
  REQUEST.set(db, meta);
}

const PROTECTED_HINT = /migration|workflow|\bci\b|infra/i;

export function audit(
  db: TenantState,
  orgId: string,
  actor: ActorRef,
  action: string,
  resource: string,
  detail = "",
  at = Date.now(),
) {
  db.auditLogs.unshift({
    id: newId("aud"),
    orgId,
    actor,
    action,
    resource,
    at: toIso(at),
    detail,
    ip: actor.type === "person" ? (REQUEST.get(db)?.ip ?? null) : null,
  });
}

export function notify(
  db: TenantState,
  orgId: string,
  kind: string,
  title: string,
  body: string,
  href: string,
  at = Date.now(),
) {
  db.notifications.unshift({
    id: newId("ntf"),
    orgId,
    userId: null,
    kind,
    title,
    body,
    href,
    at: toIso(at),
    read: false,
  });
}

function policyFor(db: TenantState, orgId: string) {
  return db.policies.find((p) => p.orgId === orgId);
}

export function repoName(repo: Repository) {
  return repo.fullName;
}

// ---------------------------------------------------------------- DevPilot
export function startSession(
  db: TenantState,
  task: Task,
  by: ActorRef,
  opts: { notes?: string; simulateFailure?: boolean; now: number },
): Session {
  const agent = db.agents.find((a) => a.id === task.agentId)!;
  const attempt = db.sessions.filter((s) => s.taskId === task.id).length + 1;
  const id = `sess_${task.id.replace(/^task_/, "")}_${attempt}`;
  const { mode, sim } = fx(db);
  const simulated = mode === "simulated";
  const needsApproval =
    simulated &&
    PROTECTED_HINT.test(`${task.title} ${task.description}`) &&
    !db.approvals.some((a) => a.context.taskId === task.id && a.status === "approved");
  const session: Session = {
    id,
    taskId: task.id,
    orgId: task.orgId,
    agentId: agent.id,
    attempt,
    status: "running",
    startedAt: toIso(opts.now),
    endedAt: null,
    tokensIn: 0,
    tokensOut: 0,
    costUsd: 0,
    summary: null,
    changedFiles: [],
    headSha: null,
    waitingFor: null,
    notes: opts.notes ?? null,
    logSeed: Math.floor(opts.now % 10_000),
    simulated,
    simulatedEndsAt: simulated ? opts.now + sim.runMs : undefined,
    simulateFailure: simulated ? (opts.simulateFailure ?? false) : undefined,
    approvalCheckpointAt: needsApproval ? opts.now + Math.round(sim.runMs * 0.45) : undefined,
  };
  db.sessions.push(session);
  if (!simulated)
    fx(db).enqueue({
      kind: "session.run",
      payload: { sessionId: id },
      dedupeKey: `session.run:${task.orgId}:${id}`,
      maxAttempts: 1,
    });
  const repo = db.repositories.find((r) => r.id === task.repositoryId)!;
  db.workspaces.push({
    id: `wk_${id.replace(/^sess_/, "")}`,
    sessionId: id,
    orgId: task.orgId,
    runtime: "container",
    image: repo.ecosystems[0] === "pypi" ? "forgepilot/runner-py312" : "forgepilot/runner-node22",
    state: "active",
    cpu: 2,
    memoryGb: 4,
    diskGb: 10,
    networkPolicy: "allowlist",
    createdAt: toIso(opts.now),
    cleanupAt: toIso(opts.now + 24 * 3_600_000),
    credentials: "ephemeral, repo-scoped (expires 60 min)",
    baseSha: task.baseSha,
    branch: task.branch,
  });
  task.status = "running";
  audit(
    db,
    task.orgId,
    by,
    attempt > 1 ? "task.retried" : "task.launched",
    `task:${task.id}`,
    `${agent.name} · attempt ${attempt}`,
    opts.now,
  );
  audit(
    db,
    task.orgId,
    { type: "agent", id: agent.id },
    "agent.session_started",
    `session:${id}`,
    `workspace ${id.replace(/^sess_/, "wk_")}`,
    opts.now,
  );
  return session;
}

export function pauseForApproval(
  db: TenantState,
  session: Session,
  now: number,
  request?: { path: string; diffPreview?: string },
) {
  const task = db.tasks.find((t) => t.id === session.taskId)!;
  const policy = policyFor(db, task.orgId);
  const path =
    request?.path ??
    (/workflow|ci/i.test(task.title) ? ".github/workflows/ci.yml" : "migrations/0043_auto.py");
  const approval = {
    id: newId("apr"),
    orgId: task.orgId,
    action: "modify_protected_path" as const,
    status: "pending" as const,
    title: `Agent wants to write ${path}`,
    context: {
      taskId: task.id,
      sessionId: session.id,
      repositoryId: task.repositoryId,
      path,
      diffPreview: request?.diffPreview ?? `+ # change proposed by ${session.id}`,
    },
    requestedBy: { type: "agent" as const, id: session.agentId, sessionId: session.id },
    requestedAt: toIso(now),
    expiresAt: toIso(now + 24 * 3_600_000),
    approverRole:
      policy?.approvalRules.find((r) => r.action === "modify_protected_path")?.approverRole ??
      "admin",
    decidedBy: null,
    decidedAt: null,
    comment: null,
  };
  db.approvals.unshift(approval);
  session.status = "waiting";
  session.waitingFor = { kind: "approval", approvalId: approval.id };
  session.pausedRemainingMs = Math.max(1000, (session.simulatedEndsAt ?? now) - now);
  session.approvalCheckpointAt = undefined;
  task.status = "waiting_input";
  audit(
    db,
    task.orgId,
    { type: "agent", id: session.agentId },
    "approval.requested",
    `approval:${approval.id}`,
    approval.title,
    now,
  );
  notify(
    db,
    task.orgId,
    "approval",
    "Approval needed: protected path",
    `${task.title} · ${path}`,
    "/app/approvals",
    now,
  );
}

export function resumeSession(db: TenantState, session: Session, now: number) {
  const task = db.tasks.find((t) => t.id === session.taskId)!;
  session.status = "running";
  session.waitingFor = null;
  if (session.simulated) {
    session.simulatedEndsAt =
      now + (session.pausedRemainingMs ?? Math.round(fx(db).sim.runMs * 0.55));
    session.pausedRemainingMs = undefined;
  } else {
    fx(db).enqueue({
      kind: "session.run",
      payload: { sessionId: session.id, resume: true },
      dedupeKey: `session.run:${task.orgId}:${session.id}`,
      maxAttempts: 1,
    });
  }
  task.status = "running";
}

export function endSession(
  db: TenantState,
  session: Session,
  status: "failed" | "cancelled",
  summary: string,
  now: number,
) {
  const task = db.tasks.find((t) => t.id === session.taskId)!;
  session.status = status;
  session.endedAt = toIso(now);
  session.summary = summary;
  session.waitingFor = null;
  session.simulatedEndsAt = undefined;
  const ws = db.workspaces.find((w) => w.sessionId === session.id);
  if (ws) ws.state = "cleaned";
  if (!session.simulated)
    fx(db).enqueue({ kind: "session.cleanup", payload: { sessionId: session.id } });
  task.status = status;
  audit(
    db,
    task.orgId,
    { type: "agent", id: session.agentId },
    `agent.session_${status}`,
    `session:${session.id}`,
    summary,
    now,
  );
}

/** What the execution plane reports when an agent session finishes successfully. */
export interface SessionOutcome {
  tokensIn: number;
  tokensOut: number;
  /** Provider-reported cost; 0 when the provider does not return one. */
  costUsd: number;
  headSha: string;
  changedFiles: ChangedFile[];
  summary: string;
  /** The pull request the runtime opened or updated on GitHub. */
  pullRequest?: { number: number; url: string };
}

export function completeSession(
  db: TenantState,
  session: Session,
  now: number,
  outcome?: SessionOutcome,
) {
  const task = db.tasks.find((t) => t.id === session.taskId)!;
  const repo = db.repositories.find((r) => r.id === task.repositoryId)!;
  const agent = db.agents.find((a) => a.id === session.agentId)!;
  const minutes = Math.max(1, (now - Date.parse(session.startedAt)) / 60_000);
  session.status = "completed";
  session.endedAt = toIso(now);
  if (outcome) {
    session.tokensIn = outcome.tokensIn;
    session.tokensOut = outcome.tokensOut;
    session.costUsd = Math.round(outcome.costUsd * 100) / 100;
    session.headSha = outcome.headSha;
    session.changedFiles = outcome.changedFiles;
    session.summary = outcome.summary;
  } else {
    const tokens = 60_000 + Math.round(minutes * 23_000);
    session.tokensIn = Math.round(tokens * 0.8);
    session.tokensOut = Math.round(tokens * 0.2);
    session.costUsd =
      Math.round(tokens * (agent.provider === "claude_code" ? 0.000011 : 0.000009) * 100) / 100;
    session.headSha = fakeSha(session.id + now);
    const isPy = repo.ecosystems[0] === "pypi";
    session.changedFiles = isPy
      ? [
          { path: "app/api/handlers.py", additions: 31, deletions: 8 },
          { path: "tests/api/test_handlers.py", additions: 54, deletions: 0 },
        ]
      : [
          { path: "src/components/Feature.tsx", additions: 38, deletions: 11 },
          { path: "src/components/Feature.test.tsx", additions: 47, deletions: 0 },
          { path: "e2e/feature.spec.ts", additions: 22, deletions: 2 },
        ];
    session.summary = `Implemented "${task.title}", added tests for each acceptance criterion and ran them in the workspace.`;
  }
  session.waitingFor = null;
  session.simulatedEndsAt = undefined;
  const ws = db.workspaces.find((w) => w.sessionId === session.id);
  if (ws) ws.state = "cleaned";
  if (!session.simulated)
    fx(db).enqueue({ kind: "session.cleanup", payload: { sessionId: session.id } });
  db.usageRecords.push({
    orgId: task.orgId,
    date: toIso(now).slice(0, 10),
    projectId: task.projectId,
    meter: "agent_minutes",
    provider: agent.provider,
    units: Math.round(minutes * 10) / 10,
    costUsd: session.costUsd,
  });
  audit(
    db,
    task.orgId,
    { type: "agent", id: agent.id },
    "agent.session_completed",
    `session:${session.id}`,
    session.summary ?? "",
    now,
  );
  const headSha = session.headSha!;

  // agent.completed → create or update PR, then trigger ShipSafe (PRD §10.2).
  let pr = task.pullRequestId
    ? db.pullRequests.find((p) => p.id === task.pullRequestId)
    : undefined;
  if (!pr && task.bugId) {
    const bug = db.bugs.find((b) => b.id === task.bugId);
    pr = bug?.pullRequestId ? db.pullRequests.find((p) => p.id === bug.pullRequestId) : undefined;
    if (pr) task.pullRequestId = pr.id;
  }
  // The GitHub webhook may have recorded the PR before the worker reported back.
  if (!pr && outcome?.pullRequest) {
    pr = db.pullRequests.find(
      (p) => p.repositoryId === repo.id && p.number === outcome.pullRequest!.number,
    );
    if (pr) {
      task.pullRequestId = pr.id;
      pr.taskId = task.id;
      pr.author = { type: "agent", id: agent.id, sessionId: session.id };
    }
  }
  const additions = session.changedFiles.reduce((s, f) => s + f.additions, 0);
  const deletions = session.changedFiles.reduce((s, f) => s + f.deletions, 0);
  if (pr) {
    pr.headSha = headSha;
    pr.additions += additions;
    pr.deletions += deletions;
    pr.checkStatus = "queued";
    audit(
      db,
      task.orgId,
      { type: "agent", id: agent.id },
      "pull_request.synchronize",
      `pr:${pr.id}`,
      `pushed ${headSha.slice(0, 7)} to #${pr.number}`,
      now,
    );
  } else {
    const number = outcome?.pullRequest?.number ?? 400 + db.pullRequests.length;
    pr = {
      id: `pr_${task.id.replace(/^task_/, "")}`,
      orgId: task.orgId,
      repositoryId: repo.id,
      number,
      title: task.title,
      url: outcome?.pullRequest?.url ?? `${repo.url}/pull/${number}`,
      author: { type: "agent", id: agent.id, sessionId: session.id },
      openedBy: task.createdBy,
      branch: task.branch,
      baseSha: task.baseSha,
      headSha,
      status: "open",
      openedAt: toIso(now),
      mergedAt: null,
      mergedBy: null,
      aiAuthoredPct: 88,
      additions,
      deletions,
      changedFiles: session.changedFiles.length,
      taskId: task.id,
      checkStatus: "queued",
      reviewers: [],
      reviewState: "review_requested",
      latestRunId: null,
    };
    db.pullRequests.push(pr);
    task.pullRequestId = pr.id;
    audit(
      db,
      task.orgId,
      { type: "agent", id: agent.id },
      "pull_request.opened",
      `pr:${pr.id}`,
      `#${number} ${task.title}`,
      now,
    );
  }
  task.status = "verifying";
  const previous = pr.latestRunId ? db.testRuns.find((r) => r.id === pr!.latestRunId) : undefined;
  // The webhook for this push may already have started verification of the same commit.
  const already = db.testRuns.find((r) => r.pullRequestId === pr!.id && r.headSha === headSha);
  if (already) {
    if (already.status === "passed") task.status = "review_ready";
    else if (already.status === "failed") task.status = "failed";
    return;
  }
  startTestRun(db, repo, pr, previous ? "pull_request.synchronize" : "pull_request.opened", {
    now,
    simulateFailure: session.simulateFailure,
    retestOf: previous?.id ?? null,
  });
}

// ---------------------------------------------------------------- ShipSafe
export function startTestRun(
  db: TenantState,
  repo: Repository,
  pr: PullRequest | null,
  trigger: string,
  opts: {
    now: number;
    simulateFailure?: boolean;
    retestOf?: string | null;
    branch?: string;
    headSha?: string;
  },
): TestRun {
  const { mode, sim } = fx(db);
  const simulated = mode === "simulated";
  const suites = db.testSuites.filter((s) => s.repositoryId === repo.id && s.enabled);
  const run: TestRun = {
    id: newId("run"),
    orgId: repo.orgId,
    repositoryId: repo.id,
    pullRequestId: pr?.id ?? null,
    trigger,
    // Live runs on a branch are pinned by the worker once it resolves the branch head.
    headSha:
      pr?.headSha ?? opts.headSha ?? (simulated ? fakeSha(repo.id + opts.now) : repo.indexedSha),
    baseSha: pr?.baseSha ?? repo.indexedSha,
    branch: pr?.branch ?? opts.branch ?? repo.defaultBranch,
    environment: {
      name: pr ? "preview" : "ci-sandbox",
      url: pr ? `https://pr-${pr.number}.preview.example` : null,
      node: repo.ecosystems[0] === "npm" ? "22.11" : null,
      python: repo.ecosystems[0] === "pypi" ? "3.12" : null,
      worker: `ss-worker-${10 + (opts.now % 89)}`,
      region: "us-east",
    },
    status: "running",
    startedAt: toIso(opts.now),
    finishedAt: null,
    durationSec: null,
    selectedSuites: suites.map((s) => ({
      suiteId: s.id,
      reason:
        s.type === "unit" ? "Always run for any change" : `Changed files match ${s.pathRules[0]}`,
    })),
    retestOf: opts.retestOf ?? null,
    checkRun: { name: "ForgePilot ShipSafe", conclusion: null, detailsUrl: "" },
    totals: { passed: 0, failed: 0, flaky: 0, skipped: 0 },
    billedBrowserMinutes: 0,
    simulatedEndsAt: simulated ? opts.now + sim.verifyMs : undefined,
    simulateFailure: simulated ? (opts.simulateFailure ?? false) : undefined,
  };
  run.checkRun!.detailsUrl = `/app/shipsafe/runs/${run.id}`;
  db.testRuns.push(run);
  if (!simulated)
    fx(db).enqueue({
      kind: "testrun.execute",
      payload: { runId: run.id },
      dedupeKey: `testrun.execute:${repo.orgId}:${run.id}`,
      maxAttempts: 2,
    });
  if (pr) {
    pr.latestRunId = run.id;
    pr.checkStatus = "running";
  }
  audit(
    db,
    repo.orgId,
    { type: "system", id: "shipsafe" },
    "test_run.started",
    `run:${run.id}`,
    `${trigger} · ${run.headSha.slice(0, 7)}`,
    opts.now,
  );
  return run;
}

/** One executed test case as reported by a ShipSafe worker. */
export interface TestCaseOutcome {
  suiteId: string;
  name: string;
  outcome: TestResult["outcome"];
  classification: TestResult["classification"];
  durationMs: number;
  retries: number;
  error: string | null;
  evidence: TestResult["evidence"];
}

/** What a ShipSafe worker reports when a run ends. */
export interface TestRunOutcome {
  /** The exact commit that was tested (pins branch runs). */
  headSha?: string;
  results: TestCaseOutcome[];
  durationSec: number;
  browserMinutes: number;
  /** Set when the run could not be executed at all (worker, checkout, install…). */
  infraError?: string;
}

const MAX_BUGS_PER_RUN = 5;

function simulatedRunOutcome(db: TenantState, run: TestRun, now: number): TestRunOutcome {
  const suites = db.testSuites.filter((s) => run.selectedSuites.some((x) => x.suiteId === s.id));
  const results: TestCaseOutcome[] = [];
  suites.forEach((s, si) => {
    for (let i = 0; i < 6; i++)
      results.push({
        suiteId: s.id,
        name: `${s.type} › case ${i + 1}`,
        outcome: "passed",
        classification: null,
        durationMs: 80 + (((i + 1) * 337 * (si + 1)) % 3800),
        retries: 0,
        error: null,
        evidence: [],
      });
  });
  const e2e = suites.find((s) => s.type === "playwright") ?? suites[0];
  if (run.simulateFailure && e2e)
    results.push({
      suiteId: e2e.id,
      name: `${e2e.type === "playwright" ? "feature.spec.ts" : "test_feature.py"} › meets acceptance criterion 1`,
      outcome: "failed",
      classification: "product_defect",
      durationMs: 8400,
      retries: 0,
      error: "Expected the saved value to persist after reload, received the default value.",
      evidence: [
        { kind: "screenshot", label: "Failure screenshot", ref: `artifacts/${run.id}/failure.png` },
        { kind: "trace", label: "Playwright trace", ref: `artifacts/${run.id}/trace.zip` },
        { kind: "console", label: "Browser console", ref: `artifacts/${run.id}/console.log` },
      ],
    });
  const durationSec = Math.round((now - Date.parse(run.startedAt)) / 1000) + 140;
  return { results, durationSec, browserMinutes: Math.round((durationSec / 60) * 1.6 * 10) / 10 };
}

export function completeTestRun(
  db: TenantState,
  run: TestRun,
  now: number,
  reported?: TestRunOutcome,
) {
  const repo = db.repositories.find((r) => r.id === run.repositoryId)!;
  const pr = run.pullRequestId
    ? db.pullRequests.find((p) => p.id === run.pullRequestId)
    : undefined;
  const simulated = !reported;
  const outcome = reported ?? simulatedRunOutcome(db, run, now);
  if (outcome.headSha) run.headSha = outcome.headSha;

  const results: TestResult[] = outcome.results.map((r) => ({
    id: newId("res"),
    runId: run.id,
    ...r,
    firstFailedAt: r.outcome === "failed" ? run.startedAt : null,
  }));
  db.testResults.push(...results);
  // Honest classification (SS-009): only product and test defects fail a change.
  const defects = results.filter(
    (r) => r.outcome === "failed" && r.classification === "product_defect",
  );
  const blocking = results.filter(
    (r) =>
      r.outcome === "failed" &&
      (r.classification === "product_defect" || r.classification === "test_defect"),
  );
  const noise = results.filter((r) => r.outcome === "failed" && !blocking.includes(r));
  const infraError =
    outcome.infraError ??
    (!blocking.length && noise.length
      ? `${noise.length} failure(s) classified as ${noise[0].classification ?? "environment"}: ${noise[0].error ?? noise[0].name}`
      : undefined);
  const fail = blocking.length > 0;
  run.totals = {
    passed: results.filter((r) => r.outcome === "passed").length,
    failed: results.filter((r) => r.outcome === "failed").length,
    flaky: results.filter((r) => r.outcome === "flaky").length,
    skipped: results.filter((r) => r.outcome === "skipped").length,
  };
  run.status = fail ? "failed" : infraError ? "errored" : "passed";
  if (run.status === "errored") run.infraError = infraError;
  run.finishedAt = toIso(now);
  run.durationSec = outcome.durationSec;
  // Infrastructure failures are never billed (PRD §18.1).
  run.billedBrowserMinutes = run.status === "errored" ? 0 : outcome.browserMinutes;
  run.checkRun = {
    name: "ForgePilot ShipSafe",
    conclusion: fail ? "failure" : run.status === "errored" ? "neutral" : "success",
    detailsUrl: `/app/shipsafe/runs/${run.id}`,
  };
  run.simulatedEndsAt = undefined;
  if (run.billedBrowserMinutes > 0)
    db.usageRecords.push({
      orgId: run.orgId,
      date: toIso(now).slice(0, 10),
      projectId: repo.projectId,
      meter: "browser_minutes",
      provider: "shipsafe",
      units: run.billedBrowserMinutes,
      costUsd: Math.round(run.billedBrowserMinutes * 0.02 * 100) / 100,
    });
  if (run.status !== "errored")
    db.usageRecords.push({
      orgId: run.orgId,
      date: toIso(now).slice(0, 10),
      projectId: repo.projectId,
      meter: "test_runs",
      provider: "shipsafe",
      units: 1,
      costUsd: 0,
    });
  audit(
    db,
    run.orgId,
    { type: "system", id: "shipsafe" },
    run.status === "errored" ? "test.errored" : fail ? "test.failed" : "test.passed",
    `run:${run.id}`,
    run.status === "errored"
      ? (infraError ?? "worker error")
      : `${run.totals.passed} passed · ${run.totals.failed} failed`,
    now,
  );

  if (run.status !== "errored") captureVisuals(db, run, pr ?? null, now);
  if (!pr) return;
  // A newer commit may have superseded this run while it was executing.
  if (pr.latestRunId !== run.id) return;
  pr.checkStatus = run.status;
  if (run.status === "errored") {
    notify(
      db,
      run.orgId,
      "test_errored",
      `ShipSafe could not verify PR #${pr.number}`,
      `${pr.title} · infrastructure problem, not a defect in the change. Rerun is free.`,
      `/app/shipsafe/runs/${run.id}`,
      now,
    );
    return;
  }
  const tasks = db.tasks.filter(
    (t) => t.pullRequestId === pr.id && ["verifying", "running"].includes(t.status),
  );
  if (fail) {
    // test.failed → create linked defects and offer a DevPilot fix task (no auto-loop).
    const bugs: Bug[] = [];
    for (const defect of defects.slice(0, MAX_BUGS_PER_RUN)) {
      const suite = db.testSuites.find((x) => x.id === defect.suiteId);
      const title = simulated
        ? "Saved value does not persist after reload"
        : `Failing: ${defect.name}`.slice(0, 160);
      // A retest that still fails updates the existing bug instead of filing a duplicate.
      const existing = (simulated ? [] : db.bugs).find(
        (b) =>
          b.pullRequestId === pr.id &&
          b.title === title &&
          (b.status === "open" || b.status === "fix_in_progress"),
      );
      if (existing) {
        existing.runId = run.id;
        existing.resultId = defect.id;
        existing.commitSha = run.headSha;
        if (existing.status === "fix_in_progress") existing.status = "open";
        bugs.push(existing);
        continue;
      }
      const bug: Bug = {
        id: newId("bug"),
        orgId: run.orgId,
        repositoryId: repo.id,
        runId: run.id,
        resultId: defect.id,
        pullRequestId: pr.id,
        title,
        severity: "high",
        status: "open",
        commitSha: run.headSha,
        reproSteps: simulated
          ? [
              "Open the preview URL for this PR",
              "Change the setting and save",
              "Reload the page",
              "The default value is shown instead of the saved one",
            ]
          : [
              `Check out ${run.headSha.slice(0, 12)} of ${repo.fullName}`,
              `Run \`${suite?.command ?? "the test command"}\``,
              `Observe the failure in "${defect.name}"`,
            ],
        stackTrace: simulated
          ? `Error: expect(received).toBe(expected)\n    at ${defect.name.split(" ›")[0]}:31:18`
          : (defect.error ?? "No error output captured").slice(0, 8000),
        suspectedCause: simulated
          ? "The save handler writes to local state but the request is never awaited."
          : "Not analysed yet. Start from the failing assertion and the files changed in this PR.",
        createdAt: toIso(now),
        taskId: null,
        assigneeId: null,
      };
      db.bugs.push(bug);
      bugs.push(bug);
    }
    tasks.forEach((t) => {
      t.status = "failed";
      if (!t.bugId && bugs[0]) t.bugId = bugs[0].id;
    });
    notify(
      db,
      run.orgId,
      "test_failed",
      `ShipSafe failed on PR #${pr.number}`,
      `${pr.title} · ${blocking.length} ${defects.length ? "product defect" : "test defect"}${blocking.length === 1 ? "" : "s"}`,
      `/app/pull-requests/${pr.id}`,
      now,
    );
  } else {
    // test.passed → update verification status and notify reviewers. Never merge automatically.
    db.bugs
      .filter((b) => b.pullRequestId === pr.id && b.status === "fix_in_progress")
      .forEach((b) => {
        b.status = "resolved";
        audit(
          db,
          run.orgId,
          { type: "system", id: "shipsafe" },
          "bug.resolved",
          `bug:${b.id}`,
          `verified by ${run.id}`,
          now,
        );
      });
    tasks.forEach((t) => (t.status = "review_ready"));
    db.tasks
      .filter(
        (t) =>
          t.bugId &&
          t.status === "verifying" &&
          db.bugs.find((b) => b.id === t.bugId)?.pullRequestId === pr.id,
      )
      .forEach((t) => (t.status = "review_ready"));
    notify(
      db,
      run.orgId,
      "review_ready",
      `PR #${pr.number} passed ShipSafe`,
      `${pr.title} · ready for human review`,
      `/app/pull-requests/${pr.id}`,
      now,
    );
  }
}

// ---------------------------------------------------------------- CodeKeeper
export function startScan(
  db: TenantState,
  repo: Repository,
  trigger: "manual" | "push" | "schedule" | "onboarding",
  now: number,
): Scan {
  const simulated = fx(db).mode === "simulated";
  const scan: Scan = {
    id: newId("scan"),
    repositoryId: repo.id,
    orgId: repo.orgId,
    commitSha: repo.indexedSha,
    status: "running",
    trigger,
    startedAt: toIso(now),
    finishedAt: null,
    findingsCount: null,
    scoreAfter: null,
    scoreDelta: null,
    changes: [],
    config: {
      ecosystems: repo.ecosystems,
      checks: ["dependencies", "advisories", "ci", "tests", "docs"],
    },
    simulatedEndsAt: simulated ? now + fx(db).sim.scanMs : undefined,
  };
  db.scans.unshift(scan);
  if (!simulated)
    fx(db).enqueue({
      kind: "scan.execute",
      payload: { scanId: scan.id },
      dedupeKey: `scan.execute:${repo.orgId}:${scan.id}`,
      maxAttempts: 3,
    });
  audit(
    db,
    repo.orgId,
    { type: "system", id: "codekeeper" },
    "scan.started",
    `repo:${repo.id}`,
    trigger,
    now,
  );
  return scan;
}

export function recomputeHealth(db: TenantState, repo: Repository) {
  const open = db.findings.filter(
    (f) => f.repositoryId === repo.id && (f.status === "open" || f.status === "task_created"),
  );
  const weight = { critical: 30, high: 18, medium: 8, low: 3 } as const;
  const h = {
    dependencies: Math.max(
      30,
      100 -
        7 * open.filter((f) => f.category === "outdated" || f.category === "vulnerability").length,
    ),
    security: Math.max(
      20,
      100 -
        open
          .filter((f) => f.category === "vulnerability")
          .reduce((s, f) => s + weight[f.severity], 0),
    ),
    buildStability: open.some((f) => f.category === "build") ? 74 : 93,
    tests: open.some((f) => f.category === "tests") ? 71 : 88,
    docs: repo.health.docs,
  };
  repo.health = { ...h, score: computeHealthScore(h), scoreVersion: HEALTH_SCORE_VERSION };
}

/** What a CodeKeeper worker found in the repository at one commit. */
export interface ScanOutcome {
  commitSha: string;
  dependencies: Omit<Dependency, "id" | "orgId" | "repositoryId">[];
  advisories: {
    ecosystem: Dependency["ecosystem"];
    package: string;
    installedVersion: string;
    fixedVersion: string | null;
    advisoryId: string;
    source: string;
    sourceUrl: string;
    severity: Finding["severity"];
    title: string;
  }[];
  signals: { hasDocs: boolean; hasCi: boolean; hasTests: boolean };
}

const RISK_BAND = { critical: "urgent", high: "high", medium: "medium", low: "low" } as const;
const major = (v: string) => Number(/^[^0-9]*(\d+)/.exec(v)?.[1] ?? NaN);

/** Reconciles the inventory and findings with what the scan saw; nothing is invented. */
function applyScanOutcome(db: TenantState, repo: Repository, outcome: ScanOutcome, now: number) {
  repo.indexedSha = outcome.commitSha;
  repo.indexedAt = toIso(now);
  repo.hasDocs = outcome.signals.hasDocs;

  const depKey = (d: { ecosystem: string; name: string; manifest: string }) =>
    `${d.ecosystem}:${d.name}:${d.manifest}`;
  const before = new Map(
    db.dependencies.filter((d) => d.repositoryId === repo.id).map((d) => [depKey(d), d]),
  );
  const seenDeps = new Set<string>();
  for (const d of outcome.dependencies) {
    const key = depKey(d);
    if (seenDeps.has(key)) continue;
    seenDeps.add(key);
    const existing = before.get(key);
    if (existing) Object.assign(existing, d);
    else db.dependencies.push({ id: newId("dep"), orgId: repo.orgId, repositoryId: repo.id, ...d });
  }
  db.dependencies = db.dependencies.filter(
    (d) => d.repositoryId !== repo.id || seenDeps.has(depKey(d)),
  );
  const depId = (ecosystem: string, name: string) =>
    db.dependencies.find(
      (d) => d.repositoryId === repo.id && d.ecosystem === ecosystem && d.name === name,
    )?.id ?? null;

  type Detected = Pick<
    Finding,
    | "category"
    | "severity"
    | "title"
    | "package"
    | "dependencyId"
    | "affectedVersion"
    | "fixedVersion"
    | "advisoryId"
    | "advisorySource"
    | "sourceUrl"
    | "confidence"
    | "evidence"
  > & { key: string };
  const detected: Detected[] = [];
  for (const a of outcome.advisories)
    detected.push({
      key: `vulnerability:${a.advisoryId}:${a.package}`,
      category: "vulnerability",
      severity: a.severity,
      title: a.title,
      package: a.package,
      dependencyId: depId(a.ecosystem, a.package),
      affectedVersion: a.installedVersion,
      fixedVersion: a.fixedVersion,
      advisoryId: a.advisoryId,
      advisorySource: a.source,
      sourceUrl: a.sourceUrl,
      confidence: "high",
      evidence: `${a.package}@${a.installedVersion} is in the affected range of ${a.advisoryId} (${a.source}).${a.fixedVersion ? ` Fixed in ${a.fixedVersion}.` : " No fixed version published yet."}`,
    });
  for (const d of outcome.dependencies) {
    const behind = major(d.latestVersion) - major(d.installedVersion);
    if (!d.direct || !(behind >= 1)) continue;
    detected.push({
      key: `outdated:${d.ecosystem}:${d.name}`,
      category: "outdated",
      severity: behind >= 2 ? "medium" : "low",
      title: `${d.name} is ${behind} major version${behind === 1 ? "" : "s"} behind`,
      package: d.name,
      dependencyId: depId(d.ecosystem, d.name),
      affectedVersion: d.installedVersion,
      fixedVersion: d.latestVersion,
      advisoryId: null,
      advisorySource: null,
      sourceUrl: null,
      confidence: "high",
      evidence: `${d.manifest} pins ${d.name}@${d.installedVersion}; the registry's latest release is ${d.latestVersion}.`,
    });
  }
  if (!outcome.signals.hasCi)
    detected.push({
      key: "build:no-ci",
      category: "build",
      severity: "medium",
      title: "No CI workflow found",
      package: null,
      dependencyId: null,
      affectedVersion: null,
      fixedVersion: null,
      advisoryId: null,
      advisorySource: null,
      sourceUrl: null,
      confidence: "medium",
      evidence: "No workflow files were found under .github/workflows at this commit.",
    });
  if (!outcome.signals.hasTests)
    detected.push({
      key: "tests:no-command",
      category: "tests",
      severity: "medium",
      title: "No test command detected",
      package: null,
      dependencyId: null,
      affectedVersion: null,
      fixedVersion: null,
      advisoryId: null,
      advisorySource: null,
      sourceUrl: null,
      confidence: "medium",
      evidence: "The manifests at this commit declare no test script or test dependency.",
    });

  const keyOfFinding = (f: Finding) =>
    f.category === "vulnerability"
      ? `vulnerability:${f.advisoryId}:${f.package}`
      : f.category === "outdated"
        ? `outdated:${db.dependencies.find((d) => d.id === f.dependencyId)?.ecosystem ?? repo.ecosystems[0]}:${f.package}`
        : f.category === "build"
          ? "build:no-ci"
          : f.category === "tests"
            ? "tests:no-command"
            : `other:${f.id}`;
  const existing = new Map(
    db.findings.filter((f) => f.repositoryId === repo.id).map((f) => [keyOfFinding(f), f]),
  );
  const seen = new Set<string>();
  for (const d of detected) {
    // The same advisory can hit a package through several manifests; one finding is enough.
    if (seen.has(d.key)) continue;
    seen.add(d.key);
    const { key, ...fields } = d;
    const prev = existing.get(key);
    if (prev) {
      Object.assign(prev, fields, { lastSeenSha: outcome.commitSha });
      // A finding that was fixed and came back is reopened; suppressed ones stay suppressed.
      if (prev.status === "resolved") {
        prev.status = "open";
        prev.detectedAt = toIso(now);
        prev.taskId = null;
      }
    } else
      db.findings.push({
        id: newId("find"),
        repositoryId: repo.id,
        orgId: repo.orgId,
        ...fields,
        riskBand: RISK_BAND[d.severity],
        status: "open",
        detectedAt: toIso(now),
        lastSeenSha: outcome.commitSha,
        suppression: null,
        taskId: null,
      });
  }
  for (const [key, f] of existing)
    if (!seen.has(key) && !key.startsWith("other:") && f.status !== "resolved") {
      f.status = "resolved";
      f.suppression = null;
    }
  repo.health.docs = outcome.signals.hasDocs ? 85 : 35;
}

export function completeScan(db: TenantState, scan: Scan, now: number, outcome?: ScanOutcome) {
  const repo = db.repositories.find((r) => r.id === scan.repositoryId)!;
  const before = repo.health.score;
  const openBefore = db.findings.filter(
    (f) => f.repositoryId === repo.id && f.status !== "resolved",
  ).length;
  if (outcome) applyScanOutcome(db, repo, outcome, now);
  recomputeHealth(db, repo);
  const resolved = db.findings.filter(
    (f) => f.repositoryId === repo.id && f.status === "resolved" && Date.parse(f.detectedAt) < now,
  ).length;
  scan.status = "completed";
  scan.finishedAt = toIso(now);
  scan.commitSha = repo.indexedSha;
  scan.findingsCount = db.findings.filter(
    (f) => f.repositoryId === repo.id && f.status !== "resolved",
  ).length;
  scan.scoreAfter = repo.health.score;
  scan.scoreDelta = repo.health.score - before;
  scan.changes = outcome
    ? [
        `${outcome.dependencies.length} dependencies inventoried`,
        scan.findingsCount === openBefore
          ? "No change in open findings"
          : `Open findings ${openBefore} → ${scan.findingsCount}`,
      ]
    : scan.scoreDelta > 0
      ? [`${resolved} finding(s) resolved since the last scan`]
      : scan.scoreDelta < 0
        ? ["New findings matched"]
        : ["No change"];
  scan.simulatedEndsAt = undefined;
  const week = toIso(now).slice(0, 10);
  const last = db.healthHistory.filter((h) => h.repositoryId === repo.id).at(-1);
  if (last && last.weekStart === week) last.score = repo.health.score;
  else db.healthHistory.push({ repositoryId: repo.id, weekStart: week, score: repo.health.score });
  db.usageRecords.push({
    orgId: repo.orgId,
    date: week,
    projectId: repo.projectId,
    meter: "scan_runs",
    provider: "codekeeper",
    units: 1,
    costUsd: 0,
  });
  audit(
    db,
    repo.orgId,
    { type: "system", id: "codekeeper" },
    "scan.completed",
    `repo:${repo.id}`,
    `score ${before} → ${repo.health.score}`,
    now,
  );
  const critical = db.findings.filter(
    (f) =>
      f.repositoryId === repo.id &&
      f.status === "open" &&
      f.severity === "critical" &&
      Date.parse(f.detectedAt) >= Date.parse(scan.startedAt),
  );
  if (outcome && critical.length)
    notify(
      db,
      repo.orgId,
      "critical_finding",
      `${critical.length} critical finding${critical.length === 1 ? "" : "s"} in ${repo.fullName}`,
      critical[0].title,
      `/app/codekeeper/findings?finding=${critical[0].id}`,
      now,
    );
}

export function failScan(db: TenantState, scan: Scan, error: string, now: number) {
  scan.status = "failed";
  scan.finishedAt = toIso(now);
  scan.changes = [`Scan failed: ${error}`.slice(0, 300)];
  scan.simulatedEndsAt = undefined;
  audit(
    db,
    scan.orgId,
    { type: "system", id: "codekeeper" },
    "scan.failed",
    `repo:${scan.repositoryId}`,
    error.slice(0, 300),
    now,
  );
}

// ---------------------------------------------------------------- repository intelligence
/** What the indexer learned about a repository at its default-branch head. */
export interface IndexOutcome {
  defaultBranch: string;
  private: boolean;
  headSha: string;
  languages: string[];
  frameworks: string[];
  ecosystems: Repository["ecosystems"];
  testCommands: string[];
  ciWorkflows: string[];
  fileCount: number;
  hasDocs: boolean;
}

export function completeIndexing(
  db: TenantState,
  repo: Repository,
  now: number,
  outcome?: IndexOutcome,
) {
  if (outcome) {
    Object.assign(repo, {
      defaultBranch: outcome.defaultBranch,
      private: outcome.private,
      indexedSha: outcome.headSha,
      languages: outcome.languages,
      frameworks: outcome.frameworks,
      ecosystems: outcome.ecosystems,
      testCommands: outcome.testCommands,
      ciWorkflows: outcome.ciWorkflows,
      fileCount: outcome.fileCount,
      hasDocs: outcome.hasDocs,
    });
    // Propose one suite per discovered test command; the user confirms or edits them.
    if (!db.testSuites.some((s) => s.repositoryId === repo.id))
      outcome.testCommands.forEach((command) => {
        const type = /playwright|cypress/i.test(command)
          ? ("playwright" as const)
          : ("unit" as const);
        db.testSuites.push({
          id: newId("suite"),
          repositoryId: repo.id,
          orgId: repo.orgId,
          name: type === "playwright" ? "End-to-end (Playwright)" : `Tests (${command})`,
          type,
          command,
          environment: type === "playwright" ? "preview" : "ci-sandbox",
          pathRules: ["**"],
          timeoutMin: 20,
          owner: db.memberships.find((m) => m.role === "owner")?.userId ?? "",
          enabled: true,
          required: true,
          flakyRatePct: 0,
          testCount: 0,
        });
      });
  }
  repo.indexStatus = "ready";
  repo.indexedAt = toIso(now);
  repo.indexReadyAt = undefined;
  audit(
    db,
    repo.orgId,
    { type: "system", id: "integrations" },
    "repository.indexed",
    `repo:${repo.id}`,
    `${repo.fullName} @ ${repo.indexedSha.slice(0, 7)}`,
    now,
  );
}

export function failIndexing(db: TenantState, repo: Repository, error: string, now: number) {
  repo.indexStatus = "error";
  repo.indexReadyAt = undefined;
  audit(
    db,
    repo.orgId,
    { type: "system", id: "integrations" },
    "repository.index_failed",
    `repo:${repo.id}`,
    error.slice(0, 300),
    now,
  );
}

// ---------------------------------------------------------------- time-driven transitions
/**
 * Applies everything that is due at `now`: simulated work that has finished,
 * approvals that expired and suppressions that lapsed. Idempotent.
 */
export function advance(db: TenantState, now: number) {
  for (const s of db.sessions) {
    if (!s.simulated || s.status !== "running") continue;
    if (s.approvalCheckpointAt && now >= s.approvalCheckpointAt) {
      pauseForApproval(db, s, s.approvalCheckpointAt);
      continue;
    }
    if (s.simulatedEndsAt && now >= s.simulatedEndsAt) completeSession(db, s, s.simulatedEndsAt);
  }
  for (const r of db.testRuns)
    if (r.status === "running" && r.simulatedEndsAt && now >= r.simulatedEndsAt)
      completeTestRun(db, r, r.simulatedEndsAt);
  for (const scan of db.scans)
    if (scan.status === "running" && scan.simulatedEndsAt && now >= scan.simulatedEndsAt)
      completeScan(db, scan, scan.simulatedEndsAt);
  for (const repo of db.repositories)
    if (repo.indexStatus === "indexing" && repo.indexReadyAt && now >= repo.indexReadyAt)
      completeIndexing(db, repo, repo.indexReadyAt);

  for (const a of db.approvals) {
    if (a.status !== "pending" || Date.parse(a.expiresAt) > now) continue;
    a.status = "expired";
    audit(
      db,
      a.orgId,
      { type: "system", id: "devpilot" },
      "approval.expired",
      `approval:${a.id}`,
      a.title,
      now,
    );
    const s =
      typeof a.context.sessionId === "string"
        ? db.sessions.find((x) => x.id === a.context.sessionId)
        : undefined;
    if (s && s.status === "waiting" && s.waitingFor?.approvalId === a.id)
      endSession(db, s, "failed", `Stopped: approval "${a.title}" expired without a decision`, now);
  }
  for (const f of db.findings) {
    if (f.status !== "suppressed" || !f.suppression || Date.parse(f.suppression.expiresAt) > now)
      continue;
    f.status = "open";
    f.suppression = null;
    audit(
      db,
      f.orgId,
      { type: "system", id: "codekeeper" },
      "finding.suppression_expired",
      `finding:${f.id}`,
      f.title,
      now,
    );
  }
}

/** The next moment `advance` has something to do, or null when nothing is scheduled. */
export function nextDueAt(db: TenantState): number | null {
  const due: number[] = [];
  for (const s of db.sessions)
    if (s.simulated && s.status === "running") {
      if (s.approvalCheckpointAt) due.push(s.approvalCheckpointAt);
      if (s.simulatedEndsAt) due.push(s.simulatedEndsAt);
    }
  for (const r of db.testRuns)
    if (r.status === "running" && r.simulatedEndsAt) due.push(r.simulatedEndsAt);
  for (const s of db.scans)
    if (s.status === "running" && s.simulatedEndsAt) due.push(s.simulatedEndsAt);
  for (const r of db.repositories)
    if (r.indexStatus === "indexing" && r.indexReadyAt) due.push(r.indexReadyAt);
  for (const a of db.approvals) if (a.status === "pending") due.push(Date.parse(a.expiresAt));
  for (const f of db.findings)
    if (f.status === "suppressed" && f.suppression) due.push(Date.parse(f.suppression.expiresAt));
  return due.length ? Math.min(...due) : null;
}

/** Seeded "running" work gets realistic timings relative to when the demo was (re)seeded. */
export function prepareSimulation(db: TenantState, now: number) {
  const LONG = 40 * 60_000;
  // One seeded agent session finishes about a minute after seeding so the loop is visible.
  const plan: Record<string, number> = { sess_003_1: 75_000 };
  db.sessions.forEach((s) => {
    if (s.status === "running") {
      s.simulated = true;
      s.startedAt = toIso(now - 3 * 60_000);
      s.simulatedEndsAt = now + (plan[s.id] ?? LONG);
    }
    if (s.status === "waiting") {
      s.simulated = true;
      s.startedAt = toIso(now - 9 * 60_000);
      s.pausedRemainingMs = 60_000;
    }
  });
  const runTimes = [25_000, 40_000, 60_000];
  db.testRuns
    .filter((r) => r.status === "running")
    .forEach((r, i) => {
      r.startedAt = toIso(now - 2 * 60_000);
      r.simulatedEndsAt = now + (runTimes[i] ?? 60_000);
    });
}

/** Simulated GitHub merge webhook: GitHub is the source of truth for merge state. */
export function applyMerge(db: TenantState, pr: PullRequest, by: string, now: number) {
  pr.status = "merged";
  pr.mergedAt = toIso(now);
  pr.mergedBy = by;
  const repo = db.repositories.find((r) => r.id === pr.repositoryId)!;
  repo.indexedSha = pr.headSha;
  repo.indexedAt = toIso(now);
  db.tasks
    .filter((t) => t.pullRequestId === pr.id && t.status !== "completed")
    .forEach((t) => {
      t.status = "completed";
      if (t.findingId) {
        const f = db.findings.find((x) => x.id === t.findingId);
        if (f) f.status = "resolved";
      }
    });
  audit(
    db,
    pr.orgId,
    { type: "person", id: by },
    "pull_request.merged",
    `pr:${pr.id}`,
    `#${pr.number} merged in GitHub`,
    now,
  );
  // MAINTAIN: CodeKeeper rescans the updated repository.
  startScan(db, repo, "push", now);
}

// ---------------------------------------------------------------- ShipSafe visual comparison (PRD §7.5)
const UI_CHANGE =
  /redesign|layout|style|dark|density|spacing|contrast|theme|\bui\b|table|page|form|button/i;

/**
 * Capture baseline-vs-candidate screenshots for the pages this repository tracks.
 * A change that looks UI-related produces one "changed" snapshot that needs an explicit
 * baseline decision; decisions already made for the same page carry over to retests.
 */
export function captureVisuals(db: TenantState, run: TestRun, pr: PullRequest | null, now: number) {
  const known = db.visualSnapshots.filter((v) => v.repositoryId === run.repositoryId);
  if (!known.length) return;
  const pages = new Map<string, { name: string; route: string; viewport: "desktop" | "mobile" }>();
  known.forEach((v) =>
    pages.set(`${v.name}|${v.viewport}`, { name: v.name, route: v.route, viewport: v.viewport }),
  );
  const previous = pr ? db.visualSnapshots.filter((v) => v.pullRequestId === pr.id) : [];
  const task = pr?.taskId ? db.tasks.find((t) => t.id === pr.taskId) : undefined;
  const uiChange = !!pr && UI_CHANGE.test(`${pr.title} ${task?.description ?? ""}`);
  const target = [...pages.values()].find((p) => p.viewport === "desktop");
  let i = 0;
  for (const page of pages.values()) {
    i++;
    const prior = previous.find(
      (v) => v.name === page.name && v.viewport === page.viewport && v.status !== "unchanged",
    );
    const changed =
      !!prior || (uiChange && page.name === target?.name && page.viewport === "desktop");
    const carried = prior && prior.status === "approved";
    db.visualSnapshots.push({
      id: newId("vis"),
      orgId: run.orgId,
      runId: run.id,
      pullRequestId: pr?.id ?? null,
      repositoryId: run.repositoryId,
      name: page.name,
      route: page.route,
      viewport: page.viewport,
      theme: "light",
      status: !changed ? "unchanged" : carried ? "approved" : "changed",
      diffPct: changed ? (prior?.diffPct ?? 5.6) : 0,
      regions: changed ? (prior?.regions ?? [{ x: 6, y: 26, w: 60, h: 36 }]) : [],
      variant: (i + Math.round(now / 1000)) % 5,
      baselineSha: run.baseSha,
      candidateSha: run.headSha,
      decidedBy: carried ? prior!.decidedBy : null,
      decidedAt: carried ? prior!.decidedAt : null,
      comment: carried ? "Approved on an earlier commit of this PR" : null,
    });
  }
}

/** Approve a changed screenshot as the new baseline, or reject it as a visual regression (filed as a bug). */
export function decideVisual(
  db: TenantState,
  id: string,
  decision: "approved" | "rejected",
  comment: string,
  by: string,
  now: number,
) {
  const v = db.visualSnapshots.find((x) => x.id === id)!;
  v.status = decision;
  v.decidedBy = by;
  v.decidedAt = toIso(now);
  v.comment = comment || null;
  audit(
    db,
    v.orgId,
    { type: "person", id: by },
    decision === "approved" ? "visual.baseline_approved" : "visual.rejected",
    `run:${v.runId}`,
    `${v.name} (${v.viewport})`,
    now,
  );
  if (decision === "rejected") {
    const result: TestResult = {
      id: newId("res"),
      runId: v.runId,
      suiteId:
        db.testRuns.find((r) => r.id === v.runId)!.selectedSuites[0]?.suiteId ??
        db.testSuites.find((s) => s.repositoryId === v.repositoryId)!.id,
      name: `visual › ${v.name} (${v.viewport})`,
      outcome: "failed",
      classification: "product_defect",
      durationMs: 0,
      retries: 0,
      error: `Rejected visual change (${v.diffPct}% of pixels differ): ${comment}`,
      evidence: [
        { kind: "screenshot", label: "Baseline", ref: `artifacts/${v.runId}/${v.id}-baseline.png` },
        {
          kind: "screenshot",
          label: "Candidate",
          ref: `artifacts/${v.runId}/${v.id}-candidate.png`,
        },
      ],
      firstFailedAt: toIso(now),
    };
    db.testResults.push(result);
    db.bugs.push({
      id: newId("bug"),
      orgId: v.orgId,
      repositoryId: v.repositoryId,
      runId: v.runId,
      resultId: result.id,
      pullRequestId: v.pullRequestId,
      title: `Visual regression on ${v.name} (${v.viewport})`,
      severity: "medium",
      status: "open",
      commitSha: v.candidateSha,
      reproSteps: [
        `Open ${v.route} at ${v.viewport === "desktop" ? "1280×800" : "390×844"}`,
        "Compare with the approved baseline",
        comment,
      ],
      stackTrace: "Visual comparison: rejected by reviewer",
      suspectedCause: "A style or layout change in this PR altered the highlighted region.",
      createdAt: toIso(now),
      taskId: null,
      assigneeId: null,
    });
  }
  return v;
}

// ---------------------------------------------------------------- GitHub issue import (DP-010)
const PRIORITY_LABEL = [
  [/urgent|p0|critical/i, "urgent"],
  [/high|p1|security|bug/i, "high"],
  [/low|p3|good first issue/i, "low"],
] as const;

export function issuePriority(labels: string[]): "urgent" | "high" | "medium" | "low" {
  for (const [re, p] of PRIORITY_LABEL) if (labels.some((l) => re.test(l))) return p;
  return "medium";
}

/** "- [ ] item" checklists in the issue body become acceptance criteria. */
export function issueCriteria(body: string, title: string): string[] {
  const items = body
    .split("\n")
    .map((l) => l.match(/^\s*[-*]\s*\[[ xX]?\]\s*(.+)$/)?.[1]?.trim())
    .filter((x): x is string => !!x && x.length >= 3);
  return items.length
    ? items
    : [`${title} works as described in the issue`, "Tests added and passing"];
}
