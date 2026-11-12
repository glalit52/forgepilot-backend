/**
 * Live execution, end to end, with no network: a fake GitHub/OSV/npm API behind
 * `fetch`, a local bare git repository as the remote and a shell script standing
 * in for the Claude Code CLI. Everything else is the real code path: GitHub App
 * auth, indexing, scanning, clone → agent → commit → push → PR, commit-pinned
 * test runs in a workspace, protected-path approvals and signed webhooks.
 */
import { execFileSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hmacSha256 } from "../src/platform/crypto";
import { createHarness, waitFor, type Client, type Harness } from "./helpers";

const root = mkdtempSync(join(tmpdir(), "fp-live-"));
const bare = join(root, "remote.git");
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
    },
  }).trim();

const WEBHOOK_SECRET = "whsec-test";
const TOKEN = "ghs_installationtoken123456";
const requests: { method: string; url: string; body: any }[] = [];
const pull: Record<string, any> = { number: 7, state: "open", merged: false };
const manifests: Record<string, string> = {
  "package.json": JSON.stringify({
    scripts: { test: "sh test.sh" },
    dependencies: { express: "^4.17.1", lodash: "4.17.20" },
    devDependencies: { "@playwright/test": "^1.40.0" },
  }),
  "package-lock.json": JSON.stringify({
    lockfileVersion: 3,
    packages: {
      "": {},
      "node_modules/express": { version: "4.17.1" },
      "node_modules/lodash": { version: "4.17.20" },
      "node_modules/@playwright/test": { version: "1.40.0" },
      "node_modules/qs": { version: "6.7.0" },
    },
  }),
  "README.md": "# web",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const fakeFetch: typeof fetch = async (input, init) => {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  const body = init?.body ? JSON.parse(String(init.body)) : undefined;
  requests.push({ method, url: url.toString(), body });
  const p = url.pathname;
  if (url.host === "api.anthropic.com") return json({ data: [] });
  if (url.host === "registry.npmjs.org")
    return json({
      version: p.includes("express") ? "5.1.0" : p.includes("lodash") ? "4.17.21" : "1.40.0",
      license: "MIT",
    });
  if (url.host === "api.osv.dev") {
    if (p === "/v1/querybatch")
      return json({
        results: body.queries.map((q: any) =>
          q.package.name === "lodash" ? { vulns: [{ id: "GHSA-test-0001" }] } : {},
        ),
      });
    return json({
      id: "GHSA-test-0001",
      summary: "Command injection in lodash",
      database_specific: { severity: "HIGH" },
      affected: [
        {
          package: { name: "lodash", ecosystem: "npm" },
          ranges: [{ type: "SEMVER", events: [{ introduced: "0" }, { fixed: "4.17.21" }] }],
        },
      ],
    });
  }
  if (url.host !== "api.github.com") return json({ message: "unexpected host" }, 500);
  const main = () => git(bare, "rev-parse", "refs/heads/main");
  if (p === "/app/installations/42") return json({ account: { login: "acme" } });
  if (p === "/app/installations/42/access_tokens")
    return json({ token: TOKEN, expires_at: new Date(Date.now() + 3_600_000).toISOString() });
  const repo = {
    full_name: "acme/web",
    private: true,
    language: "TypeScript",
    default_branch: "main",
    pushed_at: "2026-11-01T00:00:00Z",
    html_url: "https://github.com/acme/web",
  };
  if (p === "/installation/repositories") return json({ repositories: [repo] });
  if (p === "/repos/acme/web") return json(repo);
  if (p === "/repos/acme/web/branches/main") return json({ commit: { sha: main() } });
  if (p.startsWith("/repos/acme/web/git/trees/"))
    return json({
      truncated: false,
      tree: [...Object.keys(manifests), ".github/workflows/ci.yml", "src/index.ts"].map((path) => ({
        path,
        type: "blob",
      })),
    });
  if (p.startsWith("/repos/acme/web/contents/")) {
    const file = manifests[decodeURIComponent(p.slice("/repos/acme/web/contents/".length))];
    return file
      ? json({ type: "file", encoding: "base64", content: Buffer.from(file).toString("base64") })
      : json({}, 404);
  }
  if (p === "/repos/acme/web/languages") return json({ TypeScript: 9000, CSS: 100 });
  if (p === "/repos/acme/web/issues")
    return json([
      {
        number: 3,
        title: "Add health endpoint",
        body: "- [ ] GET /health returns 200\n- [ ] Covered by a test",
        state: "open",
        html_url: "https://github.com/acme/web/issues/3",
        comments: 1,
        created_at: "2026-11-01T00:00:00Z",
        user: { login: "octo" },
        labels: [{ name: "p1" }],
      },
    ]);
  const pullDto = () => ({
    number: 7,
    title: pull.title,
    html_url: "https://github.com/acme/web/pull/7",
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.merged ? new Date().toISOString() : null,
    created_at: new Date().toISOString(),
    additions: 3,
    deletions: 0,
    changed_files: 1,
    user: { login: "forgepilot[bot]" },
    merged_by: pull.merged ? { login: "octo" } : null,
    head: { ref: pull.head, sha: git(bare, "rev-parse", `refs/heads/${pull.head}`) },
    base: { ref: "main", sha: main() },
  });
  if (p === "/repos/acme/web/pulls" && method === "POST") {
    Object.assign(pull, { title: body.title, head: body.head });
    return json(pullDto(), 201);
  }
  if (p === "/repos/acme/web/pulls/7") return json(pullDto());
  if (p === "/repos/acme/web/check-runs") return json({ id: 99 }, 201);
  if (p === "/repos/acme/web/check-runs/99") return json({ id: 99 });
  return json({ message: `no fake for ${method} ${p}` }, 404);
};

let h: Harness;
let owner: Client;
let repoId: string;
let agentId: string;

async function webhook(event: string, payload: unknown, delivery: string) {
  const raw = JSON.stringify(payload);
  return h.server.inject({
    method: "POST",
    url: "/api/v1/webhooks/github",
    headers: {
      "content-type": "application/json",
      "x-github-event": event,
      "x-github-delivery": delivery,
      "x-hub-signature-256": `sha256=${hmacSha256(WEBHOOK_SECRET, raw)}`,
    },
    payload: raw,
  });
}
const task = (id: string, status: string) => async () => {
  const body = (await owner.get(`/tasks/${id}`)).body;
  if (body.task.status === "failed" && status !== "failed")
    throw new Error(`task failed: ${body.sessions.at(-1)?.summary}`);
  return body.task.status === status ? body : false;
};

beforeAll(async () => {
  // A remote with one commit on main, and a test command that passes.
  const work = join(root, "seed");
  mkdirSync(work);
  git(root, "init", "--quiet", "--bare", "--initial-branch=main", bare);
  git(bare, "config", "uploadpack.allowAnySHA1InWant", "true");
  git(work, "init", "--quiet", "--initial-branch=main");
  writeFileSync(join(work, "test.sh"), "test -f feature.txt || echo 'no feature yet'\nexit 0\n");
  writeFileSync(join(work, "README.md"), "# web\n");
  git(work, "add", ".");
  git(work, "commit", "--quiet", "-m", "initial");
  git(work, "push", "--quiet", bare, "HEAD:refs/heads/main");

  // Stand-in for the Claude Code CLI: edits files and speaks the stream-json protocol.
  const agent = join(root, "fake-claude.sh");
  writeFileSync(
    agent,
    `#!/bin/sh
case "$*" in
  *"Update the CI workflow"*) mkdir -p .github/workflows && echo "name: ci" > .github/workflows/ci.yml ;;
esac
case "$*" in
  *"Leak the key"*) echo "key=$ANTHROPIC_API_KEY" >> feature.txt ;;
  *) echo "implemented by agent" >> feature.txt ;;
esac
echo "{\\"type\\":\\"assistant\\",\\"message\\":{\\"content\\":[{\\"type\\":\\"text\\",\\"text\\":\\"Using key $ANTHROPIC_API_KEY\\"}]}}"
echo '{"type":"assistant","message":{"content":[{"type":"text","text":"Adding the feature"},{"type":"tool_use","name":"Edit","input":{"file_path":"feature.txt"}}]}}'
echo '{"type":"result","subtype":"success","is_error":false,"result":"Added feature.txt and verified it.","total_cost_usd":0.42,"usage":{"input_tokens":1200,"output_tokens":300}}'
`,
  );
  chmodSync(agent, 0o755);

  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  h = await createHarness(
    {
      DEMO_MODE: "false",
      EXECUTION_MODE: "live",
      EXECUTION_SANDBOX: "process",
      WORKSPACE_ROOT: join(root, "workspaces"),
      CLAUDE_CODE_BIN: agent,
      GITHUB_APP_ID: "1234",
      GITHUB_APP_PRIVATE_KEY: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      GITHUB_WEBHOOK_SECRET: WEBHOOK_SECRET,
    },
    {
      fetch: fakeFetch,
      // Same GitHub-backed access as production, except git talks to the local remote.
      repos: (github) => ({
        remote: async () => ({ url: bare, token: null }),
        branchHead: github.branchHead.bind(github),
        openPullRequest: github.openPullRequest.bind(github),
        startCheck: github.startCheck.bind(github),
        finishCheck: github.finishCheck.bind(github),
        index: github.index.bind(github),
        scan: github.scan.bind(github),
      }),
    },
  );
  owner = h.client();
  await owner.post("/signup", {
    name: "Ada Lovelace",
    email: "ada@example.com",
    method: "email",
    password: "correct horse battery",
  });
  await owner.post("/orgs", { name: "Acme", kind: "team", useCase: "ship_ai_code_safely" });
});
afterAll(async () => {
  await h?.close();
  rmSync(root, { recursive: true, force: true });
});

describe("live mode", () => {
  it("links the GitHub App installation, connects a repository and indexes it from GitHub", async () => {
    expect((await owner.get("/agents")).body).toEqual([]);
    expect((await owner.post("/github/install", { account: "spoofed" })).status).toBe(422);
    const install = await owner.post("/github/install", { account: "spoofed", installationId: 42 });
    expect(install.status, JSON.stringify(install.body)).toBe(200);
    expect(install.body.account).toBe("acme"); // from GitHub, not from the request
    expect((await owner.get("/github/repositories")).body).toEqual([
      {
        fullName: "acme/web",
        private: true,
        language: "TypeScript",
        defaultBranch: "main",
        pushedAt: "2026-11-01T00:00:00Z",
        alreadyConnected: false,
      },
    ]);
    const connected = await owner.post("/repositories/connect", {
      repositories: ["acme/web"],
      projectId: null,
      newProjectName: "Web",
    });
    expect(connected.status, JSON.stringify(connected.body)).toBe(200);
    repoId = connected.body.repositoryIds[0];
    expect((await owner.get(`/repositories/${repoId}`)).body.repository.health.security).toBeNull(); // unknown, not "healthy"

    const detail = await waitFor(h, async () => {
      const d = (await owner.get(`/repositories/${repoId}`)).body;
      return d.repository.indexStatus === "ready" && d;
    });
    expect(detail.repository).toMatchObject({
      languages: ["typescript", "css"],
      frameworks: ["Express"],
      ecosystems: ["npm"],
      testCommands: ["npm test", "npx playwright test"],
      ciWorkflows: ["ci.yml"],
      hasDocs: true,
    });
    expect(detail.suites.map((s: { command: string }) => s.command)).toEqual([
      "npm test",
      "npx playwright test",
    ]);
    const issues = await waitFor(h, async () => {
      const list = (await owner.get("/github/issues")).body;
      return list.length && list;
    });
    expect(issues[0]).toMatchObject({
      number: 3,
      suggestedPriority: "high",
      suggestedCriteria: ["GET /health returns 200", "Covered by a test"],
    });
  });

  it("scans real manifests against OSV and the registry, and explains the findings", async () => {
    const scan = await owner.post(`/repositories/${repoId}/scans`);
    expect(scan.status).toBe(200);
    const detail = await waitFor(h, async () => {
      const d = (await owner.get(`/repositories/${repoId}`)).body;
      return d.scans[0]?.status === "completed" && d;
    });
    expect(detail.dependencies).toBe(4);
    const findings = (await owner.get("/findings")).body;
    const vuln = findings.find((f: { category: string }) => f.category === "vulnerability");
    expect(vuln).toMatchObject({
      package: "lodash",
      severity: "high",
      advisoryId: "GHSA-test-0001",
      affectedVersion: "4.17.20",
      fixedVersion: "4.17.21",
      status: "open",
    });
    expect(vuln.lastSeenSha).toBe(git(bare, "rev-parse", "refs/heads/main"));
    expect(findings.find((f: { category: string }) => f.category === "outdated")).toMatchObject({
      package: "express",
      fixedVersion: "5.1.0",
    });
    expect(detail.repository.health.security).toBeLessThan(100);
    expect(detail.repository.health.score).toBeGreaterThan(0);
    const deps = (await owner.get("/dependencies?filter=vulnerable")).body;
    expect(deps.map((d: { name: string }) => d.name)).toEqual(["lodash"]);
  });

  it("stores the agent key encrypted and never returns it", async () => {
    const res = await owner.post("/integrations/claude_code/connect", {
      account: "ignored",
      credentials: { apiKey: "sk-ant-supersecret-123456" },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain("supersecret");
    const row = (await h.app.db.query<{ ciphertext: string }>(`SELECT ciphertext FROM credentials`))
      .rows[0];
    expect(row.ciphertext).not.toContain("supersecret");
    expect(JSON.stringify((await owner.get("/integrations")).body)).not.toContain("supersecret");
    agentId = (await owner.get("/agents")).body[0].id;
    // The repository's own commands, runnable in this test environment.
    for (const s of (await owner.get("/test-suites")).body)
      await owner.post(
        `/test-suites/${s.id}`,
        s.type === "unit" ? { command: "sh test.sh" } : { enabled: false },
      );
  });

  const newTask = (title: string) => ({
    repositoryId: repoId,
    title,
    description: "Add the feature file and make sure the test script still passes afterwards.",
    acceptanceCriteria: ["feature.txt exists", "tests pass"],
    constraints: [],
    priority: "medium",
    agentId,
    targetBranch: "main",
    budgetUsd: 5,
    timeoutMin: 5,
    launch: true,
  });

  it("runs an agent in a workspace, pushes a branch, opens a PR and verifies the exact commit", async () => {
    const created = await owner.post("/tasks", newTask("Add feature file"));
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    const done = await waitFor(h, task(created.body.id, "review_ready"), 20_000).catch(
      async (e) => {
        const d = (await owner.get(`/tasks/${created.body.id}`)).body;
        const jobs = await h.app.db.query(
          `SELECT kind, status, attempts, last_error FROM jobs WHERE status <> 'done'`,
        );
        throw new Error(
          `${e.message} :: ${d.task.status} ${JSON.stringify(d.sessions.map((x: any) => [x.status, x.summary]))} runs=${JSON.stringify(d.runs.map((r: any) => [r.status, r.infraError]))} jobs=${JSON.stringify(jobs.rows)}`,
        );
      },
    );

    const session = done.sessions[0];
    const head = git(bare, "rev-parse", `refs/heads/${done.task.branch}`);
    expect(session).toMatchObject({
      status: "completed",
      simulated: false,
      headSha: head,
      costUsd: 0.42,
      tokensIn: 1200,
      tokensOut: 300,
    });
    expect(session.changedFiles).toEqual([{ path: "feature.txt", additions: 1, deletions: 0 }]);
    expect(git(bare, "log", "-1", "--format=%an", head)).toBe("ForgePilot Agent");
    expect(git(bare, "rev-parse", "refs/heads/main")).not.toBe(head); // never pushes to the target branch

    expect(done.pullRequest).toMatchObject({
      number: 7,
      url: "https://github.com/acme/web/pull/7",
      checkStatus: "passed",
      headSha: head,
    });
    const opened = requests.find((r) => r.method === "POST" && r.url.endsWith("/pulls"))!;
    expect(opened.body).toMatchObject({
      head: done.task.branch,
      base: "main",
      title: "Add feature file",
    });
    expect(done.runs[0]).toMatchObject({ status: "passed", headSha: head });
    const check = requests.find((r) => r.method === "PATCH" && r.url.endsWith("/check-runs/99"))!;
    expect(check.body.conclusion).toBe("success");

    // Logs and diff are the real ones, with the provider key and git token redacted.
    const log = (await owner.get(`/sessions/${session.id}/log`)).body;
    const text = log.lines.map((l: { text: string }) => l.text).join("\n");
    expect(text).toContain("edit feature.txt");
    expect(text).toContain("Using key [REDACTED]");
    expect(text).not.toContain("supersecret");
    const diff = (await owner.get(`/sessions/${session.id}/diff`)).body;
    expect(diff[0]).toMatchObject({ path: "feature.txt", status: "added", aiAuthored: true });
    expect(
      (await owner.get(`/test-runs/${done.runs[0].id}`)).body.workerLog.some(
        (l: { text: string }) => l.text.includes("sh test.sh"),
      ),
    ).toBe(true);
    // Merging is GitHub's job.
    expect((await owner.post(`/pull-requests/${done.pullRequest.id}/merge`)).status).toBe(409);
  });

  it("applies a merge only when GitHub says so, verifies the signature and ignores redeliveries", async () => {
    const payload = {
      action: "closed",
      installation: { id: 42 },
      repository: { full_name: "acme/web" },
      pull_request: { number: 7 },
    };
    const forged = await h.server.inject({
      method: "POST",
      url: "/api/v1/webhooks/github",
      headers: {
        "content-type": "application/json",
        "x-github-event": "pull_request",
        "x-github-delivery": "d-0",
        "x-hub-signature-256": "sha256=deadbeef",
      },
      payload: JSON.stringify(payload),
    });
    expect(forged.statusCode).toBe(401);

    // The payload claims "closed", but GitHub's API still says open: nothing is merged.
    expect((await webhook("pull_request", payload, "d-1")).statusCode).toBe(202);
    await h.app.worker.drain();
    const prId = (await owner.get("/pull-requests")).body[0].id;
    expect((await owner.get(`/pull-requests/${prId}`)).body.pullRequest.status).toBe("open");

    Object.assign(pull, { state: "closed", merged: true });
    expect((await webhook("pull_request", payload, "d-2")).json()).toEqual({
      ok: true,
      duplicate: false,
    });
    expect((await webhook("pull_request", payload, "d-2")).json()).toEqual({
      ok: true,
      duplicate: true,
    });
    const merged = await waitFor(h, async () => {
      const d = (await owner.get(`/pull-requests/${prId}`)).body;
      return d.pullRequest.status === "merged" && d;
    });
    expect(merged.task.status).toBe("completed");
    // MAINTAIN: the merge triggers a CodeKeeper rescan.
    await waitFor(
      h,
      async () =>
        (await owner.get(`/repositories/${repoId}`)).body.scans.filter(
          (s: { trigger: string; status: string }) =>
            s.trigger === "push" && s.status === "completed",
        ).length > 0,
    );
  });

  it("holds changes to protected paths until an admin approves, then publishes them", async () => {
    Object.assign(pull, { state: "open", merged: false });
    const created = await owner.post("/tasks", newTask("Update the CI workflow"));
    const waiting = await waitFor(h, task(created.body.id, "waiting_input"), 30_000);
    const approval = waiting.approvals[0];
    expect(approval).toMatchObject({
      action: "modify_protected_path",
      status: "pending",
      approverRole: "admin",
    });
    expect(approval.context.path).toBe(".github/workflows/ci.yml");
    // Nothing was pushed while waiting.
    expect(() => git(bare, "rev-parse", "--verify", `refs/heads/${waiting.task.branch}`)).toThrow();

    expect(
      (await owner.post(`/approvals/${approval.id}/decision`, { decision: "approved" })).status,
    ).toBe(200);
    const done = await waitFor(h, task(created.body.id, "review_ready"), 30_000);
    expect(git(bare, "show", "--stat", "--format=", `refs/heads/${done.task.branch}`)).toContain(
      ".github/workflows/ci.yml",
    );
  });

  it("refuses to publish a change that contains a credential given to the session", async () => {
    const created = await owner.post("/tasks", newTask("Leak the key"));
    const failed = await waitFor(
      h,
      async () => {
        const d = (await owner.get(`/tasks/${created.body.id}`)).body;
        return d.task.status === "failed" && d;
      },
      30_000,
    );
    expect(failed.sessions[0].summary).toMatch(/contains a credential/);
    expect(() => git(bare, "rev-parse", "--verify", `refs/heads/${failed.task.branch}`)).toThrow();
    expect(
      JSON.stringify((await owner.get(`/sessions/${failed.sessions[0].id}/log`)).body),
    ).not.toContain("supersecret");
  });

  it("reports a failing test as a bug with the real output, and an unrunnable command without blaming the change", async () => {
    const suite = (await owner.get("/test-suites")).body.find(
      (s: { enabled: boolean }) => s.enabled,
    );
    await owner.post(`/test-suites/${suite.id}`, {
      command: "echo 'AssertionError: expected 200, got 500' && exit 1",
    });
    const run = await owner.post("/test-runs", { repositoryId: repoId, branch: "main" });
    expect(run.status, JSON.stringify(run.body)).toBe(200);
    const failed = await waitFor(
      h,
      async () => {
        const d = (await owner.get(`/test-runs/${run.body.id}`)).body;
        return d.run.status !== "running" && d;
      },
      30_000,
    );
    expect(failed.run).toMatchObject({
      status: "failed",
      headSha: git(bare, "rev-parse", "refs/heads/main"),
    });
    expect(failed.results[0]).toMatchObject({
      outcome: "failed",
      classification: "product_defect",
      retries: 1,
    });
    expect(failed.results[0].error).toContain("expected 200, got 500");

    await owner.post(`/test-suites/${suite.id}`, { enabled: false });
    const empty = await owner.post("/test-runs", { repositoryId: repoId, branch: "main" });
    const errored = await waitFor(
      h,
      async () => {
        const d = (await owner.get(`/test-runs/${empty.body.id}`)).body;
        return d.run.status !== "running" && d;
      },
      30_000,
    );
    expect(errored.run.status).toBe("errored");
    expect(errored.run.billedBrowserMinutes).toBe(0);
    expect(errored.bugs).toEqual([]);
  });

  it("stops launches at the plan's concurrent-session limit", async () => {
    // End the trial: the Free plan runs one agent session at a time.
    const orgId = (await owner.get("/session")).body.workspace.id;
    await h.app.store.write(orgId, (db) => void (db.organizations[0].trialEndsAt = null));
    const first = await owner.post("/tasks", newTask("Add feature file again"));
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    const second = await owner.post("/tasks", newTask("Add another feature"));
    expect(second.status).toBe(402);
    expect(second.body.error).toMatch(/1 agent session at a time/);
    // Refused launches leave nothing behind.
    expect((await owner.get("/tasks?q=another")).body).toEqual([]);
    // The slot frees up when the session ends (the earlier test left no enabled suite, so it stays in verification).
    await waitFor(h, task(first.body.id, "verifying"), 30_000);
    expect((await owner.post("/tasks", newTask("Add another feature"))).status).toBe(200);
    await waitFor(
      h,
      async () => (await owner.get("/sessions?status=running")).body.length === 0,
      30_000,
    );
  });
});
