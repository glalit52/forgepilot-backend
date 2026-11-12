/** Staff back-office, suspension, deletion, retention, usage reporting and account-safety rules. */
import type Stripe from "stripe";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, type Client, type Harness } from "./helpers";

let h: Harness;
let staff: Client;
let owner: Client;
let orgId: string;
const PASSWORD = "correct horse battery";
const meterEvents: { event_name: string; identifier: string; payload: Record<string, string> }[] =
  [];
const fakeStripe = {
  billing: {
    meterEvents: { create: async (e: (typeof meterEvents)[number]) => void meterEvents.push(e) },
  },
  subscriptions: { cancel: async () => ({}) },
} as unknown as Stripe;

async function signUp(email: string, name: string) {
  const c = h.client();
  const res = await c.post("/signup", { name, email, method: "email", password: PASSWORD });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return c;
}
async function verify(email: string) {
  await h.app.worker.drain();
  const mail = h.app.mailer.outbox
    .filter((m) => m.to === email && /Confirm your email/.test(m.subject))
    .at(-1)!;
  const token = /token=([\w-]+)/.exec(mail.text)![1];
  expect((await h.client().post("/auth/verify-email", { token })).status).toBe(200);
  expect((await h.client().post("/auth/verify-email", { token })).status).toBe(400);
}

beforeAll(async () => {
  h = await createHarness(
    {
      DEMO_MODE: "false",
      PLATFORM_ADMIN_EMAILS: "boss@forgepilot.dev",
      STRIPE_SECRET_KEY: "sk_test_x",
      STRIPE_PRICES: "{}",
      STRIPE_METERS: JSON.stringify({ agent_minutes: "fp_agent_minutes" }),
    },
    { stripe: fakeStripe },
  );
  owner = await signUp("ada@example.com", "Ada Lovelace");
  orgId = (
    await owner.post("/orgs", { name: "Analytical Engines", kind: "team", useCase: "verify_prs" })
  ).body.id;
  staff = await signUp("boss@forgepilot.dev", "The Boss");
});
afterAll(() => h.close());

describe("staff back-office", () => {
  it("is invisible until the staff email is verified, and to everyone else", async () => {
    // Signing up with a staff address is not enough: the address must be proven.
    expect((await staff.get("/admin/overview")).status).toBe(404);
    await verify("boss@forgepilot.dev");
    const overview = await staff.get("/admin/overview");
    expect(overview.status, JSON.stringify(overview.body)).toBe(200);
    expect(overview.body).toMatchObject({
      workspaces: 1,
      users: 2,
      byPlan: { free: 1 },
      executionMode: "simulated",
    });
    expect((await owner.get("/admin/overview")).status).toBe(404);
    expect((await h.client().get("/admin/overview")).status).toBe(401);
    const doc = (await h.client().get("/openapi.json")).body;
    expect(Object.keys(doc.paths).some((p) => p.includes("/admin"))).toBe(false);
  });

  it("finds workspaces and users without exposing their content", async () => {
    const found = (await staff.get("/admin/workspaces?q=analytical")).body;
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ id: orgId, plan: "free", members: 1, suspendedAt: null });
    const detail = (await staff.get(`/admin/workspaces/${orgId}`)).body;
    expect(detail.members).toEqual([
      expect.objectContaining({ email: "ada@example.com", role: "owner" }),
    ]);
    expect(detail.counts).toMatchObject({ projects: 0, activeSessions: 0 });
    const users = (await staff.get("/admin/users?q=ada")).body;
    expect(users[0]).toMatchObject({ email: "ada@example.com", emailVerified: false });
    expect(users[0].workspaces[0]).toMatchObject({ id: orgId, role: "owner" });
  });

  it("suspends a workspace to read-only, restores it, and tells the customer in their audit log", async () => {
    expect((await staff.post(`/admin/workspaces/${orgId}/suspend`, { reason: "no" })).status).toBe(
      422,
    );
    const suspended = await staff.post(`/admin/workspaces/${orgId}/suspend`, {
      reason: "Chargeback under review",
    });
    expect(suspended.body.suspendedReason).toBe("Chargeback under review");
    const blocked = await owner.post("/projects", { name: "Nope", description: "" });
    expect(blocked.status).toBe(403);
    expect(blocked.body.code).toBe("workspace_suspended");
    expect((await owner.get("/overview")).status).toBe(200);

    await staff.post(`/admin/workspaces/${orgId}/unsuspend`, { reason: "Payment received" });
    expect((await owner.post("/projects", { name: "Back", description: "" })).status).toBe(200);
    const log = (await owner.get("/audit-logs")).body.map((a: { action: string }) => a.action);
    expect(log).toEqual(expect.arrayContaining(["workspace.suspended", "workspace.restored"]));
    const trail = (await staff.get("/admin/audit")).body.map(
      (a: { action: string; staff: string }) => `${a.staff} ${a.action}`,
    );
    expect(trail).toEqual(
      expect.arrayContaining([
        "boss@forgepilot.dev workspace.suspended",
        "boss@forgepilot.dev workspace.restored",
      ]),
    );
  });

  it("sets an enterprise plan by hand and retries failed jobs", async () => {
    const set = await staff.post(`/admin/workspaces/${orgId}/plan`, {
      plan: "enterprise",
      reason: "Signed order form 2026-114",
    });
    expect(set.body.plan).toBe("enterprise");
    expect((await owner.get("/session")).body.workspace).toMatchObject({
      plan: "enterprise",
      trialEndsAt: null,
    });

    await h.app.db.query(
      `INSERT INTO jobs (kind, status, attempts, last_error) VALUES ('test.noop', 'failed', 5, 'boom')`,
    );
    const failed = (await staff.get("/admin/jobs?status=failed")).body;
    expect(failed[0]).toMatchObject({ kind: "test.noop", lastError: "boom" });
    expect((await staff.post(`/admin/jobs/${failed[0].id}/retry`)).status).toBe(200);
    expect((await staff.post(`/admin/jobs/${failed[0].id}/retry`)).status).toBe(404);
    await h.app.db.query(`DELETE FROM jobs WHERE kind = 'test.noop'`);
  });
});

describe("account safety", () => {
  it("gives an unverified account to the person GitHub has verified, dropping the squatter's password", async () => {
    const squatter = await signUp("victim@example.com", "Not The Victim");
    expect((await squatter.get("/me")).status).toBe(200);
    const user = await h.app.identity.upsertOAuthUser({
      provider: "github",
      providerUserId: "9001",
      email: "victim@example.com",
      name: "Victim",
      login: "victim",
    });
    expect((await squatter.get("/me")).status).toBe(401);
    expect(
      (await h.client().post("/auth/login", { email: "victim@example.com", password: PASSWORD }))
        .status,
    ).toBe(401);
    // Signing in with GitHub again resolves to the same account.
    const again = await h.app.identity.upsertOAuthUser({
      provider: "github",
      providerUserId: "9001",
      email: "changed@example.com",
      name: "Victim",
    });
    expect(again.id).toBe(user.id);
  });

  it("deletes an account only when no workspace would be left without an owner", async () => {
    const sole = await owner.post("/me/delete", { confirm: "ada@example.com" });
    expect(sole.status).toBe(409);
    expect(sole.body.error).toMatch(/only owner of Analytical Engines/);
    const loner = await signUp("temp@example.com", "Temp User");
    expect((await loner.post("/me/delete", { confirm: "wrong@example.com" })).status).toBe(422);
    expect((await loner.post("/me/delete", { confirm: "temp@example.com" })).status).toBe(200);
    expect(
      (await h.client().post("/auth/login", { email: "temp@example.com", password: PASSWORD }))
        .status,
    ).toBe(401);
  });
});

describe("housekeeping", () => {
  it("applies the workspace's retention policy to logs, artifacts and audit entries", async () => {
    await h.app.store.write(orgId, (db) => {
      db.policies[0].retentionDays = { logs: 7, artifacts: 7, audit: 30 };
      db.auditLogs.push({
        id: "aud_old",
        orgId,
        actor: { type: "system", id: "shipsafe" },
        action: "test.passed",
        resource: "run:x",
        at: "2020-01-01T00:00:00Z",
        detail: "",
        ip: null,
      });
    });
    await h.app.db.query(
      `INSERT INTO session_log_lines (org_id, session_id, seq, at, level, text) VALUES ($1, 's', 0, now() - interval '30 days', 'info', 'old'), ($1, 's', 1, now(), 'info', 'new')`,
      [orgId],
    );
    await h.app.db.query(
      `INSERT INTO artifacts (org_id, kind, ref_id, data, created_at) VALUES ($1, 'run_log', 'old', '[]', now() - interval '30 days')`,
      [orgId],
    );
    await h.app.maintenance.applyRetention();
    const lines = await h.app.db.query<{ text: string }>(
      `SELECT text FROM session_log_lines WHERE org_id = $1`,
      [orgId],
    );
    expect(lines.rows.map((r) => r.text)).toEqual(["new"]);
    expect(
      (await h.app.db.query(`SELECT 1 FROM artifacts WHERE org_id = $1`, [orgId])).rows,
    ).toHaveLength(0);
    const state = await h.app.store.read(orgId);
    expect(state.auditLogs.some((l) => l.id === "aud_old")).toBe(false);
    expect(state.auditLogs.length).toBeGreaterThan(3);
  });

  it("reports each completed day of metered usage to Stripe exactly once", async () => {
    const day = (offset: number) =>
      new Date(Date.now() - offset * 86_400_000).toISOString().slice(0, 10);
    await h.app.db.query(`UPDATE organizations SET stripe_customer_id = 'cus_ada' WHERE id = $1`, [
      orgId,
    ]);
    await h.app.store.write(orgId, (db) => {
      const base = { orgId, projectId: "p", provider: "claude_code", costUsd: 1 };
      db.usageRecords.push(
        { ...base, date: day(1), meter: "agent_minutes", units: 12.5 },
        { ...base, date: day(1), meter: "agent_minutes", units: 7.5 },
        { ...base, date: day(2), meter: "agent_minutes", units: 3 },
        { ...base, date: day(0), meter: "agent_minutes", units: 99 }, // today is not complete yet
        { ...base, date: day(1), meter: "test_runs", units: 4 }, // not a metered meter
      );
    });
    expect(await h.app.maintenance.reportUsage()).toBe(2);
    expect(await h.app.maintenance.reportUsage()).toBe(0);
    expect(
      meterEvents
        .map((e) => [e.event_name, e.identifier, e.payload.value, e.payload.stripe_customer_id])
        .sort(),
    ).toEqual(
      [
        ["fp_agent_minutes", `${orgId}:agent_minutes:${day(1)}`, "20", "cus_ada"],
        ["fp_agent_minutes", `${orgId}:agent_minutes:${day(2)}`, "3", "cus_ada"],
      ].sort(),
    );
  });
});

describe("workspace deletion", () => {
  it("needs an owner and the exact name, then removes everything the workspace owned", async () => {
    await owner.post("/api-keys", { name: "CI", scopes: ["read"] });
    expect((await owner.post("/workspace/delete", { confirm: "analytical engines" })).status).toBe(
      422,
    );
    const gone = await owner.post("/workspace/delete", { confirm: "Analytical Engines" });
    expect(gone.status, JSON.stringify(gone.body)).toBe(200);
    expect((await owner.get("/overview")).status).toBe(403);
    expect((await owner.get("/session/status")).body).toMatchObject({
      signedIn: true,
      hasWorkspace: false,
    });
    for (const table of [
      "tenant_records",
      "memberships",
      "api_key_secrets",
      "usage_reports",
      "session_log_lines",
    ])
      expect(
        (await h.app.db.query(`SELECT 1 FROM ${table} WHERE org_id = $1`, [orgId])).rows,
        table,
      ).toHaveLength(0);
    expect((await staff.get(`/admin/workspaces/${orgId}`)).status).toBe(404);
  });
});
