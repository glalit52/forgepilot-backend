/**
 * The closed loop and its guardrails, exercised through HTTP against a real
 * (in-process) Postgres with the job queue driving time-based transitions.
 * Ported from the web app's mock-API tests so both stay behaviourally equal.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { shiftSeedTimes } from "../src/demo/seed";
import { MockDbSchema } from "../src/contract/schemas";
import { createHarness, demoSeed, waitFor, type Client, type Harness } from "./helpers";

let h: Harness;
let maya: Client;
const as = async (userId: string, orgId: string) => {
  const c = h.client();
  await c.signInAs(userId, orgId);
  return c;
};

beforeEach(async () => {
  h = await createHarness({ FP_SIM_RUN_MS: "400", FP_SIM_VERIFY_MS: "200", FP_SIM_SCAN_MS: "150" });
  maya = await as("u_maya", "ws_lumen");
});
afterEach(() => h.close());

const newTask = (overrides = {}) => ({
  repositoryId: "repo_web",
  title: "Add CSV export to reports",
  description: "Users need to export the report table as CSV for finance reconciliation.",
  acceptanceCriteria: ["CSV matches visible columns", "Large exports stream"],
  constraints: [],
  priority: "medium",
  agentId: "agent_claude_lumen",
  targetBranch: "main",
  budgetUsd: 5,
  timeoutMin: 30,
  launch: true,
  ...overrides,
});
const taskStatus = (id: string, status: string) => async () => {
  const body = (await maya.get(`/tasks/${id}`)).body;
  return body.task.status === status ? body : false;
};

describe("tenant isolation and permissions", () => {
  it("returns 404 for another workspace's records", async () => {
    expect((await maya.get("/tasks/task_015")).status).toBe(404); // Northwind task
    expect((await (await as("u_sofia", "ws_northwind")).get("/tasks/task_015")).status).toBe(200);
  });
  it("ignores a workspace cookie the user is not a member of", async () => {
    const dev = await as("u_dev", "ws_lumen");
    dev.cookies.fp_ws = "ws_northwind";
    expect((await dev.get("/session")).body.workspace.id).toBe("ws_lumen");
    expect((await dev.get("/tasks/task_015")).status).toBe(404);
    expect((await dev.post("/session/workspace", { orgId: "ws_northwind" })).status).toBe(403);
  });
  it("viewers can read but not act", async () => {
    const viewer = await as("u_jordan", "ws_lumen");
    expect((await viewer.get("/overview")).status).toBe(200);
    expect((await viewer.post("/tasks", newTask())).status).toBe(403);
  });
  it("approvals need the named role, and requesters can't approve themselves", async () => {
    expect(
      (
        await (
          await as("u_alex", "ws_lumen")
        ).post("/approvals/apr_001/decision", { decision: "approved" })
      ).status,
    ).toBe(403);
    expect(
      (
        await (
          await as("u_dev", "ws_lumen")
        ).post("/approvals/apr_003/decision", { decision: "approved" })
      ).status,
    ).toBe(403);
  });
});

describe("closed loop (PRD §10)", () => {
  it("task → agent → PR → ShipSafe pass → review-ready; merge only after review; then CodeKeeper rescans", async () => {
    const created = await maya.post("/tasks", newTask());
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    const id = created.body.id;
    expect((await maya.get(`/tasks/${id}`)).body.task.status).toBe("running");

    const verifying = await waitFor(h, taskStatus(id, "verifying"));
    expect(verifying.pullRequest.author.type).toBe("agent");
    const ready = await waitFor(h, taskStatus(id, "review_ready"));
    expect(ready.task.verified).toBe(true);
    expect(ready.lifecycle.find((s: { key: string }) => s.key === "merge").state).toBe("upcoming");

    const prId = verifying.task.pullRequestId;
    // No auto-merge: merging without human review is refused.
    expect((await maya.post(`/pull-requests/${prId}/merge`)).status).toBe(409);
    expect(
      (await maya.post(`/pull-requests/${prId}/review`, { decision: "approved" })).status,
    ).toBe(200);
    // A UI change produced a changed screenshot: merge waits for an explicit baseline decision.
    const blocked = await maya.post(`/pull-requests/${prId}/merge`);
    expect(blocked.status).toBe(409);
    expect(blocked.body.error).toMatch(/Visual changes approved/);
    const changed = (await maya.get(`/visual-snapshots?pullRequestId=${prId}&status=changed`))
      .body[0];
    expect(
      (await maya.post(`/visual-snapshots/${changed.id}/decision`, { decision: "approved" }))
        .status,
    ).toBe(200);
    expect((await maya.post(`/pull-requests/${prId}/merge`)).status).toBe(200);
    expect((await maya.get(`/tasks/${id}`)).body.task.status).toBe("completed");
    expect((await maya.get("/repositories/repo_web")).body.repository.scanRunning).toBe(true);
    await waitFor(
      h,
      async () => !(await maya.get("/repositories/repo_web")).body.repository.scanRunning,
    );

    // The whole journey is in the audit trail, attributed to people, the agent and the system.
    const actions = (await maya.get("/audit-logs?limit=40")).body.map(
      (a: { action: string }) => a.action,
    );
    for (const a of [
      "task.created",
      "agent.session_completed",
      "pull_request.opened",
      "test.passed",
      "pull_request.merged",
      "scan.completed",
    ])
      expect(actions).toContain(a);
  });

  it("failure → linked bug → fix task on the same PR → retest passes → bug resolved", async () => {
    const id = (await maya.post("/tasks", newTask({ title: "Remember table density preference" })))
      .body.id;
    expect((await maya.post(`/tasks/${id}/actions`, { action: "cancel" })).status).toBe(200);
    const id2 = (
      await maya.post(
        "/tasks",
        newTask({ title: "Persist table density preference", launch: false }),
      )
    ).body.id;
    expect(
      (await maya.post(`/tasks/${id2}/actions`, { action: "launch", simulateFailure: true }))
        .status,
    ).toBe(200);
    const failed = await waitFor(h, taskStatus(id2, "failed"));
    const bugId = failed.task.bugId;
    expect(bugId).toBeTruthy();

    const fix = await maya.post(`/bugs/${bugId}/actions`, { action: "create_fix_task" });
    expect(fix.status, JSON.stringify(fix.body)).toBe(200);
    expect(fix.body.bug.status).toBe("fix_in_progress");
    await waitFor(h, taskStatus(fix.body.bug.taskId, "review_ready"));
    const pr = (await maya.get(`/pull-requests/${failed.task.pullRequestId}`)).body;
    // Runs started within the same second sort arbitrarily, so look the latest one up by id.
    const latest = pr.runs.find((r: { id: string }) => r.id === pr.pullRequest.latestRunId);
    expect(latest.status).toBe("passed");
    expect(latest.retestOf).toBeTruthy();
    expect(pr.bugs.find((b: { status: string }) => b.status === "resolved")).toBeTruthy();
  });

  it("pauses for approval on protected paths and resumes when approved", async () => {
    const id = (
      await maya.post(
        "/tasks",
        newTask({ title: "Add migration for report indexes", repositoryId: "repo_payments" }),
      )
    ).body.id;
    const waiting = await waitFor(h, taskStatus(id, "waiting_input"));
    const approval = waiting.approvals.find((a: { status: string }) => a.status === "pending");
    expect((await maya.get("/session")).body.counts.pendingApprovals).toBeGreaterThan(0);
    const dev = await as("u_dev", "ws_lumen");
    expect(
      (await dev.post(`/approvals/${approval.id}/decision`, { decision: "approved" })).status,
    ).toBe(200);
    expect((await maya.get(`/tasks/${id}`)).body.task.status).toBe("running");
    expect(
      (await dev.post(`/approvals/${approval.id}/decision`, { decision: "approved" })).status,
    ).toBe(409);
    await waitFor(h, taskStatus(id, "review_ready"));
  });

  it("stops the session when an approval is rejected", async () => {
    const id = (
      await maya.post(
        "/tasks",
        newTask({ title: "Update CI workflow cache", repositoryId: "repo_payments" }),
      )
    ).body.id;
    const waiting = await waitFor(h, taskStatus(id, "waiting_input"));
    const approval = waiting.approvals.find((a: { status: string }) => a.status === "pending");
    const dev = await as("u_dev", "ws_lumen");
    await dev.post(`/approvals/${approval.id}/decision`, {
      decision: "rejected",
      comment: "Not this sprint",
    });
    const failed = (await maya.get(`/tasks/${id}`)).body;
    expect(failed.task.status).toBe("failed");
    expect(failed.sessions.at(-1).summary).toMatch(/rejected/);
  });

  it("caps fix attempts per bug", async () => {
    for (let i = 0; i < 2; i++)
      await maya.post("/bugs/bug_002/actions", { action: "create_fix_task" });
    const capped = await maya.post("/bugs/bug_002/actions", { action: "create_fix_task" });
    expect(capped.status).toBe(409);
    expect(capped.body.error).toMatch(/limit/);
  });

  it("never classifies infrastructure failures as product defects", async () => {
    const runs = (await maya.get("/test-runs?status=errored")).body;
    expect(runs.length).toBeGreaterThan(0);
    expect(runs[0].failureClasses.product_defect ?? 0).toBe(0);
    const bugs = (await maya.get("/bugs")).body;
    expect(bugs.some((b: { runId: string }) => b.runId === runs[0].id)).toBe(false);
  });

  it("rolls the whole write back when a request fails part-way", async () => {
    const before = (await maya.get("/tasks")).body.length;
    await maya.post("/billing/budget", { monthlyLimitUsd: 1, hardCap: true, alertAtPct: [80] });
    expect((await maya.post("/tasks", newTask())).status).toBe(402);
    // The mock left a half-created task behind here; a transaction must not.
    expect((await maya.get("/tasks")).body.length).toBe(before);
  });
});

describe("findings and billing", () => {
  it("creates a policy-validated maintenance task from a finding", async () => {
    const f = (await maya.get("/findings?status=open&category=vulnerability")).body[0];
    const r = await maya.post(`/findings/${f.id}/actions`, { action: "create_task" });
    expect(r.status).toBe(200);
    expect(r.body.finding.status).toBe("task_created");
    expect(r.body.task.source).toBe("codekeeper_finding");
  });
  it("suppression needs an admin, a reason and a policy-bounded expiry", async () => {
    const f = (await maya.get("/findings?status=open")).body[0];
    const input = { action: "suppress", reason: "Accepted risk for Q1", expiresInDays: 30 };
    expect(
      (await (await as("u_alex", "ws_lumen")).post(`/findings/${f.id}/actions`, input)).status,
    ).toBe(403);
    expect(
      (await maya.post(`/findings/${f.id}/actions`, { ...input, expiresInDays: 400 })).status,
    ).toBe(422);
    expect((await maya.post(`/findings/${f.id}/actions`, input)).status).toBe(200);
  });
  it("enforces plan seat limits on downgrade and lets only owners change plans", async () => {
    expect(
      (
        await (
          await as("u_dev", "ws_lumen")
        ).post("/billing/plan", { plan: "pro", billingCycle: "monthly" })
      ).status,
    ).toBe(403);
    const r = await maya.post("/billing/plan", { plan: "pro", billingCycle: "monthly" });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/seat/);
    expect(
      (await maya.post("/billing/plan", { plan: "business", billingCycle: "annual" })).status,
    ).toBe(200);
    expect((await maya.get("/session")).body.workspace.plan).toBe("business");
  });
});

describe("demo data", () => {
  it("shifts seed timestamps to now so pending work never goes stale", async () => {
    const seed = await demoSeed();
    const later = Date.parse("2027-03-20T12:00:00Z");
    const shifted = shiftSeedTimes(seed, later);
    expect(
      Date.parse(shifted.approvals.find((x) => x.id === "apr_001")!.expiresAt),
    ).toBeGreaterThan(later);
    expect(shifted.usageRecords.at(-1)!.date).toBe("2027-03-20");
    expect(() => MockDbSchema.parse(shifted)).not.toThrow();
  });
  it("reset restores the starting story and keeps persona sessions valid", async () => {
    await maya.post("/workspace", { name: "Renamed Labs" });
    expect((await maya.get("/session")).body.workspace.name).toBe("Renamed Labs");
    expect((await h.client().post("/demo/reset")).status).toBe(200);
    expect((await maya.get("/session")).body.workspace.name).toBe("Lumen Labs");
  });
});

describe("visual comparison (PRD §7.5)", () => {
  it("rejecting a changed screenshot files a visual-regression bug and blocks the PR", async () => {
    const v = (await maya.get("/visual-snapshots?pullRequestId=pr_h1&status=changed")).body[0];
    expect(
      (await maya.post(`/visual-snapshots/${v.id}/decision`, { decision: "rejected", comment: "" }))
        .status,
    ).toBe(422);
    expect(
      (
        await maya.post(`/visual-snapshots/${v.id}/decision`, {
          decision: "rejected",
          comment: "Save button overlaps the card",
        })
      ).status,
    ).toBe(200);
    const pr = (await maya.get("/pull-requests/pr_h1")).body;
    expect(
      pr.bugs.some((b: { title: string }) => b.title.startsWith(`Visual regression on ${v.name}`)),
    ).toBe(true);
    expect(
      pr.releasePolicy.find((c: { name: string }) => c.name === "Visual changes approved").status,
    ).toBe("failed");
  });
  it("only members who manage suites can decide, and decisions are one-time", async () => {
    const v = (await maya.get("/visual-snapshots?status=changed")).body[0];
    expect(
      (
        await (
          await as("u_jordan", "ws_lumen")
        ).post(`/visual-snapshots/${v.id}/decision`, { decision: "approved" })
      ).status,
    ).toBe(403);
    expect(
      (await maya.post(`/visual-snapshots/${v.id}/decision`, { decision: "approved" })).status,
    ).toBe(200);
    expect(
      (await maya.post(`/visual-snapshots/${v.id}/decision`, { decision: "approved" })).status,
    ).toBe(409);
  });
});

describe("GitHub issue import (DP-010)", () => {
  it("turns checklists into acceptance criteria and labels into priority, and skips duplicates", async () => {
    const issues = (await maya.get("/github/issues?imported=false")).body;
    const urgent = issues.find((i: { title: string }) =>
      i.title.startsWith("Empty state for new accounts"),
    );
    expect(urgent.suggestedPriority).toBe("urgent");
    expect(urgent.suggestedCriteria).toEqual(["Show an empty state with a CTA", "Regression test"]);
    const input = { issueIds: [urgent.id], agentId: "agent_claude_lumen", launch: false };
    const r = await maya.post("/github/issues/import", input);
    expect(r.status).toBe(200);
    expect(r.body.tasks[0]).toMatchObject({
      source: "github_issue",
      sourceRef: `#${urgent.number}`,
      priority: "urgent",
      acceptanceCriteria: urgent.suggestedCriteria,
    });
    const again = await maya.post("/github/issues/import", input);
    expect(again.body.tasks).toHaveLength(0);
    expect(again.body.skipped[0]).toMatch(/already/);
  });
  it("viewers can't import and other workspaces' issues are invisible", async () => {
    const input = { issueIds: ["iss_001"], agentId: "agent_claude_lumen", launch: false };
    expect(
      (await (await as("u_jordan", "ws_lumen")).post("/github/issues/import", input)).status,
    ).toBe(403);
    const nw = (await (await as("u_sofia", "ws_northwind")).get("/github/issues")).body;
    expect(nw.every((i: { orgId: string }) => i.orgId === "ws_northwind")).toBe(true);
  });
});
