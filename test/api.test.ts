import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { identityRoutes } from "../src/identity/routes";
import { authLabel } from "../src/http/openapi";
import { createHarness, type Client, type Harness } from "./helpers";

let h: Harness;
let maya: Client;
beforeAll(async () => {
  h = await createHarness();
  maya = h.client();
  await maya.signInAs("u_maya", "ws_lumen");
});
afterAll(() => h.close());

const GETS = [
  "/session",
  "/overview",
  "/projects",
  "/projects/proj_web",
  "/repositories",
  "/repositories/repo_web",
  "/devpilot/overview",
  "/tasks",
  "/tasks/task_001",
  "/tasks/task_004",
  "/tasks/task_005",
  "/sessions",
  "/sessions/sess_002_1",
  "/sessions/sess_002_1/log",
  "/sessions/sess_001_1/diff",
  "/workspaces",
  "/agents",
  "/shipsafe/overview",
  "/test-suites",
  "/test-runs",
  "/test-runs/run_015",
  "/bugs",
  "/bugs/bug_002",
  "/pull-requests",
  "/pull-requests/pr_h1",
  "/pull-requests/pr_001/diff",
  "/codekeeper/overview",
  "/dependencies",
  "/findings",
  "/approvals",
  "/analytics",
  "/analytics?range=90",
  "/integrations",
  "/members",
  "/policy",
  "/api-keys",
  "/audit-logs",
  "/billing",
  "/notifications",
  "/search?q=pay",
  "/github/repositories",
  "/visual-snapshots",
  "/github/issues",
  "/webhook-endpoints",
];

describe("every read endpoint", () => {
  // Responses are checked against the contract schema by the server (strict outside production),
  // and snapshots are frozen in tests, so a 200 also proves the handler did not mutate shared state.
  it.each(GETS)("GET %s returns 200 with a schema-valid body", async (path) => {
    const r = await maya.get(path);
    expect(r.status, JSON.stringify(r.body).slice(0, 1500)).toBe(200);
  });

  it.each([
    ["u_sofia", "ws_northwind"],
    ["u_maya", "ws_maya"],
    ["u_jordan", "ws_lumen"],
  ])("%s in %s can load every dashboard", async (u, w) => {
    const c = h.client();
    await c.signInAs(u, w);
    for (const p of [
      "/overview",
      "/devpilot/overview",
      "/shipsafe/overview",
      "/codekeeper/overview",
      "/analytics",
      "/billing",
    ]) {
      const r = await c.get(p);
      expect(r.status, `${p} ${JSON.stringify(r.body).slice(0, 800)}`).toBe(200);
    }
  });

  it("serves every detail record the lists link to", async () => {
    const pairs: [string, (x: { id: string }) => string][] = [
      ["/tasks", (x) => `/tasks/${x.id}`],
      ["/sessions", (x) => `/sessions/${x.id}`],
      ["/test-runs", (x) => `/test-runs/${x.id}`],
      ["/pull-requests", (x) => `/pull-requests/${x.id}`],
      ["/bugs", (x) => `/bugs/${x.id}`],
      ["/findings", (x) => `/findings/${x.id}`],
      ["/projects", (x) => `/projects/${x.id}`],
      ["/repositories", (x) => `/repositories/${x.id}`],
    ];
    for (const [list, detail] of pairs) {
      const items = (await maya.get<{ id: string }[]>(list)).body;
      expect(items.length).toBeGreaterThan(0);
      for (const item of items.slice(0, 25)) {
        const r = await maya.get(detail(item));
        expect(r.status, `${detail(item)} ${JSON.stringify(r.body).slice(0, 600)}`).toBe(200);
      }
    }
  });
});

describe("contract with the web app", () => {
  const contract = readFileSync("docs/ui-contract.md", "utf8");
  const rows = contract
    .split("\n")
    .filter((l) => /^\| (GET|POST) \|/.test(l))
    .map((l) => l.split("|").map((c) => c.trim()))
    .map((c) => ({ method: c[1], path: c[2].replace(/`/g, ""), auth: c[3] }));

  it("implements every endpoint of the UI contract with the same access rule", () => {
    expect(rows.length).toBeGreaterThan(80);
    const ours = new Map(
      [...identityRoutes, ...h.app.tenantRoutes.routes].map((r) => [
        `${r.method} ${r.path}`,
        authLabel(r.auth),
      ]),
    );
    // The mock performed this check inside the handler; here the route itself requires a signed-in user.
    const stricter = new Set(["POST /orgs", "POST /session/workspace"]);
    for (const row of rows) {
      const key = `${row.method} ${row.path}`;
      expect(ours.has(key), `missing ${key}`).toBe(true);
      if (!stricter.has(key)) expect(ours.get(key), key).toBe(row.auth);
    }
  });

  it("has a unique method+path for every route", () => {
    const keys = [...identityRoutes, ...h.app.tenantRoutes.routes].map(
      (r) => `${r.method} ${r.path}`,
    );
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("uses the error envelope the web app expects, plus a code and request id", async () => {
    const r = await maya.get("/tasks/nope");
    expect(r.status).toBe(404);
    expect(r.body).toMatchObject({ error: "Task not found", code: "not_found" });
    expect(r.body.requestId).toBeTruthy();
    expect((await maya.post("/tasks", { title: "x" })).status).toBe(422);
    expect((await h.client().get("/overview")).status).toBe(401);
    expect((await maya.request("POST", "/overview")).status).toBe(405);
  });
});
