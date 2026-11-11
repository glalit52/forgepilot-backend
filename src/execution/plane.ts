/**
 * The execution plane: background handlers that do the real work behind a
 * workspace's lifecycle state. Each handler reads the state, performs slow or
 * untrusted work outside any transaction, then reports the outcome through the
 * closed-loop functions in one short write.
 *
 * Handlers are idempotent: they first check that the record is still waiting
 * for them, so a redelivered job is a no-op.
 */
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Config } from "../config";
import type { CredentialStore } from "../connectors/credentials";
import { parseUnifiedDiff } from "../connectors/github";
import type { DiffFile, LogLine, TestRun, TestSuite } from "../contract/schemas";
import {
  completeIndexing,
  completeScan,
  completeSession,
  completeTestRun,
  endSession,
  failIndexing,
  failScan,
  pauseForApproval,
  type IndexOutcome,
  type ScanOutcome,
  type TestCaseOutcome,
} from "../domain/loop";
import { redactSecrets } from "../platform/crypto";
import type { Database } from "../platform/db";
import { toIso } from "../platform/ids";
import type { Job } from "../platform/jobs";
import type { Logger } from "../platform/logger";
import type { TenantStore } from "../tenancy/store";
import { AGENT_ADAPTERS, buildPrompt, type AgentEvent } from "./agents";
import { GitError, GitWorkspace } from "./git";
import { parseJUnit } from "./junit";
import { matchesAny, runProcess, sandboxCommand, type SandboxSpec } from "./sandbox";

/** Everything the execution plane needs from the source-control provider. */
export interface RepoAccess {
  remote(orgId: string, fullName: string): Promise<{ url: string; token: string | null }>;
  branchHead(orgId: string, fullName: string, branch: string): Promise<string>;
  openPullRequest(
    orgId: string,
    fullName: string,
    input: { title: string; head: string; base: string; body: string },
  ): Promise<{ number: number; url: string }>;
  startCheck(
    orgId: string,
    fullName: string,
    input: { headSha: string; detailsUrl: string; summary: string },
  ): Promise<number | null>;
  finishCheck(
    orgId: string,
    fullName: string,
    checkId: number,
    input: {
      conclusion: "success" | "failure" | "neutral";
      title: string;
      summary: string;
      detailsUrl: string;
    },
  ): Promise<void>;
  index(orgId: string, fullName: string): Promise<IndexOutcome>;
  scan(orgId: string, fullName: string, branch: string): Promise<ScanOutcome>;
}

const JUNIT_LOCATIONS = [
  "junit.xml",
  "test-results/junit.xml",
  "reports/junit.xml",
  "test-results.xml",
];

class SessionLog {
  private buffer: Omit<LogLine, "seq">[] = [];
  private seq = 0;
  private flushing: Promise<void> = Promise.resolve();
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private db: Database,
    private orgId: string,
    private sessionId: string,
    private secrets: string[],
  ) {}

  async init() {
    const { rows } = await this.db.query<{ next: number }>(
      `SELECT COALESCE(MAX(seq) + 1, 0) AS next FROM session_log_lines WHERE org_id = $1 AND session_id = $2`,
      [this.orgId, this.sessionId],
    );
    this.seq = Number(rows[0]?.next ?? 0);
  }

  write(level: LogLine["level"], text: string) {
    // Redaction happens before anything is stored: a secret never reaches the database or the UI.
    this.buffer.push({
      at: toIso(Date.now()),
      level,
      text: redactSecrets(text, this.secrets).text.slice(0, 2000),
    });
    if (this.buffer.length >= 25) void this.flush();
    else if (!this.timer) this.timer = setTimeout(() => void this.flush(), 400);
  }

  flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const lines = this.buffer.splice(0).map((l) => ({ ...l, seq: this.seq++ }));
    if (!lines.length) return this.flushing;
    this.flushing = this.flushing
      .then(async () => {
        await this.db.query(
          `INSERT INTO session_log_lines (org_id, session_id, seq, at, level, text)
           SELECT $1, $2, (e->>'seq')::int, (e->>'at')::timestamptz, e->>'level', e->>'text'
           FROM jsonb_array_elements($3::jsonb) e ON CONFLICT DO NOTHING`,
          [this.orgId, this.sessionId, JSON.stringify(lines)],
        );
      })
      .catch(() => undefined);
    return this.flushing;
  }
}

export class ExecutionPlane {
  constructor(
    private deps: {
      config: Config;
      db: Database;
      store: TenantStore;
      repos: RepoAccess;
      credentials: CredentialStore;
      log: Logger;
    },
  ) {}

  private sandbox(image: string, network: SandboxSpec["network"]): SandboxSpec {
    return { mode: this.deps.config.execution.sandbox, image, network, cpu: 2, memoryGb: 4 };
  }

  private workdir(orgId: string, id: string) {
    return join(
      this.deps.config.execution.workspaceRoot,
      orgId,
      id.replace(/[^A-Za-z0-9_-]/g, "_"),
    );
  }

  private async saveArtifact(orgId: string, kind: string, refId: string, data: unknown) {
    await this.deps.db.query(
      `INSERT INTO artifacts (org_id, kind, ref_id, data) VALUES ($1, $2, $3, $4::jsonb)
       ON CONFLICT (org_id, kind, ref_id) DO UPDATE SET data = EXCLUDED.data, created_at = now()`,
      [orgId, kind, refId, JSON.stringify(data)],
    );
  }

  async artifact<T>(orgId: string, kind: string, refId: string): Promise<T | null> {
    const { rows } = await this.deps.db.query<{ data: T }>(
      `SELECT data FROM artifacts WHERE org_id = $1 AND kind = $2 AND ref_id = $3`,
      [orgId, kind, refId],
    );
    return rows[0]?.data ?? null;
  }

  async sessionLog(orgId: string, sessionId: string): Promise<LogLine[]> {
    const { rows } = await this.deps.db.query<{
      seq: number;
      at: Date;
      level: LogLine["level"];
      text: string;
    }>(
      `SELECT seq, at, level, text FROM session_log_lines WHERE org_id = $1 AND session_id = $2 ORDER BY seq`,
      [orgId, sessionId],
    );
    return rows.map((r) => ({
      seq: r.seq,
      at: toIso(new Date(r.at).getTime()),
      level: r.level,
      text: r.text,
    }));
  }

  // ---------------------------------------------------------------- DevPilot: agent sessions
  private async failSession(orgId: string, sessionId: string, summary: string) {
    await this.deps.store.write(orgId, (db) => {
      const s = db.sessions.find((x) => x.id === sessionId);
      if (s && (s.status === "running" || s.status === "waiting"))
        endSession(db, s, "failed", summary, Date.now());
    });
  }

  async runSession(job: Job, signal: AbortSignal): Promise<void> {
    const orgId = job.orgId!;
    const sessionId = String(job.payload.sessionId);
    const resume = job.payload.resume === true;
    const state = await this.deps.store.read(orgId);
    const session = state.sessions.find((s) => s.id === sessionId);
    if (!session || session.simulated || session.status !== "running") return;
    // An agent run costs money: never silently start it a second time after a worker crash.
    if (job.attempts > 1)
      return this.failSession(
        orgId,
        sessionId,
        "The worker was interrupted during this session. Retry the task.",
      );

    const task = state.tasks.find((t) => t.id === session.taskId)!;
    const repo = state.repositories.find((r) => r.id === task.repositoryId)!;
    const agent = state.agents.find((a) => a.id === session.agentId)!;
    const policy = state.policies[0];
    const adapter = AGENT_ADAPTERS[agent.provider];
    const secret = await this.deps.credentials.get(orgId, agent.provider);
    const remote = await this.deps.repos.remote(orgId, repo.fullName);
    const secrets = [remote.token, secret?.apiKey].filter((s): s is string => !!s);
    const log = new SessionLog(this.deps.db, orgId, sessionId, secrets);
    await log.init();
    const dir = this.workdir(orgId, sessionId);
    const workspace = new GitWorkspace(dir, remote.url, { token: remote.token });

    try {
      if (!adapter) throw new UserFacingError(`${agent.name} has no runtime adapter yet`);
      if (!secret?.apiKey)
        throw new UserFacingError(
          `Connect ${agent.name} with an API key in Integrations before launching tasks`,
        );

      // A fix task continues on the branch of the pull request it repairs.
      const existingPr = task.pullRequestId
        ? state.pullRequests.find((p) => p.id === task.pullRequestId)
        : undefined;
      const branch = existingPr?.branch ?? task.branch;
      let usage = {
        tokensIn: session.tokensIn,
        tokensOut: session.tokensOut,
        costUsd: session.costUsd,
      };
      let summary = session.summary ?? "";

      if (!resume) {
        log.write(
          "info",
          `Workspace ready · ${this.deps.config.execution.sandbox} sandbox · 2 vCPU / 4 GB`,
        );
        await workspace.clone(existingPr ? existingPr.branch : task.targetBranch);
        if (!existingPr) await workspace.createBranch(branch);
        const base = await workspace.head();
        log.write("info", `Checked out ${base.slice(0, 7)} on branch ${branch}`);
        log.write(
          "info",
          `${agent.name} (${agent.model}) started · attempt #${session.attempt} · budget $${task.budgetUsd.toFixed(2)} · timeout ${task.timeoutMin}m`,
        );

        const isolated = this.deps.config.execution.sandbox === "docker";
        const argv = adapter.command({
          bin:
            agent.provider === "claude_code"
              ? this.deps.config.execution.claudeBin
              : this.deps.config.execution.codexBin,
          prompt: buildPrompt({
            title: task.title,
            description: task.description,
            acceptanceCriteria: task.acceptanceCriteria,
            constraints: task.constraints,
            testCommands: repo.testCommands,
            protectedPaths: policy.protectedPaths,
            notes: session.notes,
          }),
          model: agent.model,
          isolated,
        });
        const shell = argv.map(shellQuote).join(" ");
        const { command, args } = sandboxCommand(this.sandbox(adapter.image, "open"), dir, shell, [
          adapter.apiKeyEnv,
        ]);

        const cancel = new AbortController();
        signal.addEventListener("abort", () => cancel.abort(), { once: true });
        let overBudget = false;
        let result: { ok: boolean; summary: string } | null = null;
        const onEvent = (e: AgentEvent) => {
          if (e.kind === "log") log.write(e.level, e.text);
          else if (e.kind === "usage") {
            usage = {
              tokensIn: e.tokensIn,
              tokensOut: e.tokensOut,
              costUsd: e.costUsd ?? usage.costUsd,
            };
            // Per-session spend ceiling (PRD §15.6), enforced as soon as the provider reports it.
            if (task.budgetUsd > 0 && usage.costUsd > task.budgetUsd) {
              overBudget = true;
              cancel.abort();
            }
          } else result = { ok: e.ok, summary: e.summary };
        };
        // Stop the process when a person cancels the session in the app.
        const watcher = setInterval(() => {
          void this.deps.store
            .read(orgId)
            .then(
              (s) =>
                s.sessions.find((x) => x.id === sessionId)?.status !== "running" && cancel.abort(),
            )
            .catch(() => undefined);
        }, 3_000);
        const run = await runProcess(command, args, {
          cwd: dir,
          env: { [adapter.apiKeyEnv]: secret.apiKey, HOME: dir, CI: "1" },
          timeoutMs: task.timeoutMin * 60_000,
          signal: cancel.signal,
          onLine: (line) => adapter.parse(line).forEach(onEvent),
        }).finally(() => clearInterval(watcher));
        const final = result as { ok: boolean; summary: string } | null;
        summary = final?.summary ?? "";

        const current = (await this.deps.store.read(orgId)).sessions.find(
          (x) => x.id === sessionId,
        );
        if (current?.status !== "running") {
          log.write(
            "warn",
            "Session cancelled; worker terminated and workspace scheduled for cleanup",
          );
          return;
        }
        if (overBudget)
          throw new UserFacingError(
            `Stopped: the session reached its $${task.budgetUsd.toFixed(2)} budget`,
          );
        if (run.timedOut)
          throw new UserFacingError(
            `Stopped: the session reached its ${task.timeoutMin} minute timeout`,
          );
        if (run.code !== 0 || final?.ok === false)
          throw new UserFacingError(
            final?.summary ||
              `The agent process exited with code ${run.code}: ${redactSecrets(run.output.slice(-400), secrets).text}`,
          );
      }

      const changes = await workspace.stagedChanges();
      if (!changes.files.length)
        throw new UserFacingError("The agent finished without changing any files");
      await this.saveArtifact(
        orgId,
        "session_diff",
        sessionId,
        parseUnifiedDiff(changes.diff, true),
      );

      // Protected paths (PRD §15.4): hold the change until a human with the right role approves it.
      const approved = (await this.deps.store.read(orgId)).approvals.some(
        (a) =>
          a.context.sessionId === sessionId &&
          a.action === "modify_protected_path" &&
          a.status === "approved",
      );
      const hit = changes.files
        .map((f) => ({ f, glob: matchesAny(f.path, policy.protectedPaths) }))
        .find((x) => x.glob);
      const rule = policy.approvalRules.find((r) => r.action === "modify_protected_path");
      if (hit && !approved) {
        if (rule?.mode === "prohibited")
          throw new UserFacingError(`Workspace policy prohibits changing ${hit.f.path}`);
        if (rule?.mode !== "allow") {
          log.write("approval", `Paused: ${hit.f.path} is a protected path; waiting for approval`);
          await log.flush();
          await this.deps.store.write(orgId, (db) => {
            const s = db.sessions.find((x) => x.id === sessionId);
            if (!s || s.status !== "running") return;
            Object.assign(s, usage, { summary });
            pauseForApproval(db, s, Date.now(), {
              path: hit.f.path,
              diffPreview: diffPreview(changes.diff, hit.f.path),
            });
          });
          return;
        }
      }

      const headSha = await workspace.commit(
        `${task.title}\n\nForgePilot task ${task.id} · session ${sessionId} · ${agent.name}`,
      );
      await workspace.push(branch);
      log.write(
        "success",
        `Committed ${headSha.slice(0, 7)} · ${changes.files.length} files changed · handing off to ShipSafe`,
      );
      const pr = existingPr
        ? { number: existingPr.number, url: existingPr.url }
        : await this.deps.repos.openPullRequest(orgId, repo.fullName, {
            title: task.title,
            head: branch,
            base: task.targetBranch,
            body: prBody(task, summary, agent.name, this.deps.config.appUrl),
          });
      await log.flush();
      await this.deps.store.write(orgId, (db) => {
        const s = db.sessions.find((x) => x.id === sessionId);
        if (!s || s.status !== "running") return;
        completeSession(db, s, Date.now(), {
          ...usage,
          headSha,
          changedFiles: changes.files,
          summary: summary || `Implemented "${task.title}".`,
          pullRequest: pr,
        });
      });
    } catch (err) {
      const message =
        err instanceof UserFacingError
          ? err.message
          : err instanceof GitError
            ? `${err.message}: ${err.output.split("\n").slice(-3).join(" ")}`
            : "The session failed because of an internal error. It was not charged as a product failure.";
      if (!(err instanceof UserFacingError))
        this.deps.log.error({ err, orgId, sessionId }, "session run failed");
      log.write("error", message);
      await log.flush();
      await this.failSession(orgId, sessionId, redactSecrets(message, secrets).text);
    } finally {
      await log.flush();
    }
  }

  async cleanupSession(job: Job): Promise<void> {
    const dir = this.workdir(job.orgId!, String(job.payload.sessionId));
    await new GitWorkspace(dir, "", { token: null }).destroy();
  }

  // ---------------------------------------------------------------- ShipSafe: test runs
  async executeTestRun(job: Job, signal: AbortSignal): Promise<void> {
    const orgId = job.orgId!;
    const runId = String(job.payload.runId);
    const state = await this.deps.store.read(orgId);
    const run = state.testRuns.find((r) => r.id === runId);
    if (!run || run.status !== "running") return;
    const repo = state.repositories.find((r) => r.id === run.repositoryId)!;
    const suites = run.selectedSuites
      .map((x) => state.testSuites.find((s) => s.id === x.suiteId))
      .filter((s): s is TestSuite => !!s);
    const detailsUrl = `${this.deps.config.appUrl}/app/shipsafe/runs/${run.id}`;
    const started = Date.now();
    const lines: LogLine[] = [];
    const note = (level: LogLine["level"], text: string) =>
      lines.push({
        seq: lines.length,
        at: toIso(Date.now()),
        level,
        text: redactSecrets(text).text.slice(0, 2000),
      });
    const dir = this.workdir(orgId, run.id);
    let checkId: number | null = null;
    let headSha = run.headSha;

    const report = async (outcome: Parameters<typeof completeTestRun>[3]) => {
      await this.saveArtifact(orgId, "run_log", run.id, lines);
      const finished = await this.deps.store.write(orgId, (db) => {
        const r = db.testRuns.find((x) => x.id === runId);
        if (!r || r.status !== "running") return null;
        completeTestRun(db, r, Date.now(), outcome);
        return {
          status: r.status as TestRun["status"],
          totals: r.totals,
          infraError: r.infraError,
        };
      });
      if (finished && checkId !== null)
        await this.deps.repos
          .finishCheck(orgId, repo.fullName, checkId, {
            conclusion:
              finished.status === "passed"
                ? "success"
                : finished.status === "failed"
                  ? "failure"
                  : "neutral",
            title:
              finished.status === "errored"
                ? "Could not verify (infrastructure)"
                : `${finished.totals.passed} passed · ${finished.totals.failed} failed`,
            summary:
              finished.status === "errored"
                ? `ShipSafe could not run this verification: ${finished.infraError}. This is not a defect in the change.`
                : `Commit ${headSha.slice(0, 12)} · ${suites.map((s) => s.name).join(", ")}`,
            detailsUrl,
          })
          .catch((err) =>
            this.deps.log.warn({ err, orgId, runId }, "could not update GitHub check run"),
          );
    };

    try {
      const remote = await this.deps.repos.remote(orgId, repo.fullName);
      // Commit pinning: a branch run is pinned to the exact head it resolved to.
      if (!run.pullRequestId)
        headSha = await this.deps.repos.branchHead(orgId, repo.fullName, run.branch);
      note(
        "info",
        `Worker ${run.environment.worker} · ${this.deps.config.execution.sandbox} sandbox · no production secrets`,
      );
      checkId = await this.deps.repos
        .startCheck(orgId, repo.fullName, {
          headSha,
          detailsUrl,
          summary: "Verification in progress",
        })
        .catch(() => null);
      const workspace = new GitWorkspace(dir, remote.url, { token: remote.token });
      await workspace.checkoutCommit(headSha);
      note("info", `Fetched ${headSha.slice(0, 7)} (base ${run.baseSha.slice(0, 7)})`);
      if (!suites.length)
        return await report({
          headSha,
          results: [],
          durationSec: 0,
          browserMinutes: 0,
          infraError: "No enabled test suites for this repository",
        });

      const image = repo.ecosystems[0] === "pypi" ? "python:3.12-slim" : "node:22-slim";
      const exec = async (shell: string, timeoutMs: number) => {
        const { command, args } = sandboxCommand(this.sandbox(image, "open"), dir, shell, []);
        return runProcess(command, args, {
          cwd: dir,
          env: { CI: "1", HOME: dir },
          timeoutMs,
          signal,
        });
      };
      const files = new Set(await readdir(dir));
      const setup = files.has("package-lock.json")
        ? "npm ci --no-audit --no-fund"
        : files.has("package.json")
          ? "npm install --no-audit --no-fund"
          : files.has("requirements.txt")
            ? "pip install --quiet -r requirements.txt"
            : null;
      if (setup) {
        note("tool", `Installing dependencies: ${setup}`);
        const res = await exec(setup, 15 * 60_000);
        if (res.code !== 0)
          return await report({
            headSha,
            results: [],
            durationSec: Math.round((Date.now() - started) / 1000),
            browserMinutes: 0,
            infraError: `Dependency installation failed (${setup}): ${tail(res.output)}`,
          });
      }

      const results: TestCaseOutcome[] = [];
      let browserMs = 0;
      for (const suite of suites) {
        note("tool", `Running ${suite.name}: ${suite.command}`);
        const timeoutMs = suite.timeoutMin * 60_000;
        let res = await exec(suite.command, timeoutMs);
        let retries = 0;
        // One retry separates flaky tests from real failures (PRD SS-009).
        if (res.code !== 0 && !res.timedOut && !res.aborted) {
          retries = 1;
          const again = await exec(suite.command, timeoutMs);
          if (again.code === 0) res = { ...again, code: -1 };
          else res = again;
        }
        if (suite.type === "playwright") browserMs += res.durationMs;
        const flaky = res.code === -1;
        const junit = await readJUnit(dir);
        const error = flaky || res.code === 0 ? null : tail(res.output, 4000);
        if (junit.length && !flaky)
          for (const c of junit.slice(0, 500))
            results.push({
              suiteId: suite.id,
              name: c.name,
              outcome: c.outcome,
              classification: c.outcome === "failed" ? "product_defect" : null,
              durationMs: c.durationMs,
              retries,
              error: c.error,
              evidence: [],
            });
        else
          results.push({
            suiteId: suite.id,
            name: `${suite.name} › ${suite.command}`,
            outcome: flaky ? "flaky" : res.code === 0 ? "passed" : "failed",
            // A timeout says nothing about the change itself, so it is never blamed on it.
            classification: flaky
              ? "flaky"
              : res.code === 0
                ? null
                : res.timedOut
                  ? "environment"
                  : "product_defect",
            durationMs: res.durationMs,
            retries,
            error: res.timedOut ? `Timed out after ${suite.timeoutMin} minutes` : error,
            evidence: error
              ? [{ kind: "log", label: "Test output", ref: `artifacts/${run.id}/${suite.id}.log` }]
              : [],
          });
        note(
          res.code === 0 ? "success" : flaky ? "warn" : "error",
          `${suite.name}: ${flaky ? "passed on retry (flaky)" : res.code === 0 ? "passed" : "failed"}`,
        );
      }
      await report({
        headSha,
        results,
        durationSec: Math.round((Date.now() - started) / 1000),
        browserMinutes: Math.round((browserMs / 60_000) * 10) / 10,
      });
    } catch (err) {
      if (signal.aborted) throw err;
      this.deps.log.error({ err, orgId, runId }, "test run failed to execute");
      note("error", "Worker error");
      await report({
        headSha,
        results: [],
        durationSec: Math.round((Date.now() - started) / 1000),
        browserMinutes: 0,
        infraError:
          err instanceof GitError
            ? `${err.message}: ${tail(err.output, 300)}`
            : "The worker could not execute this run",
      });
    } finally {
      await new GitWorkspace(dir, "", { token: null }).destroy().catch(() => undefined);
    }
  }

  // ---------------------------------------------------------------- CodeKeeper & repository intelligence
  async executeScan(job: Job): Promise<void> {
    const orgId = job.orgId!;
    const scanId = String(job.payload.scanId);
    const state = await this.deps.store.read(orgId);
    const scan = state.scans.find((s) => s.id === scanId);
    if (!scan || scan.status !== "running") return;
    const repo = state.repositories.find((r) => r.id === scan.repositoryId)!;
    try {
      const outcome = await this.deps.repos.scan(orgId, repo.fullName, repo.defaultBranch);
      await this.deps.store.write(orgId, (db) => {
        const s = db.scans.find((x) => x.id === scanId);
        if (s && s.status === "running") completeScan(db, s, Date.now(), outcome);
      });
    } catch (err) {
      // Let the queue retry transient provider errors; record the failure on the last attempt.
      if (job.attempts < job.maxAttempts) throw err;
      await this.deps.store.write(orgId, (db) => {
        const s = db.scans.find((x) => x.id === scanId);
        if (s && s.status === "running") failScan(db, s, (err as Error).message, Date.now());
      });
    }
  }

  async indexRepository(job: Job): Promise<void> {
    const orgId = job.orgId!;
    const repositoryId = String(job.payload.repositoryId);
    const state = await this.deps.store.read(orgId);
    const repo = state.repositories.find((r) => r.id === repositoryId);
    if (!repo) return;
    try {
      const outcome = await this.deps.repos.index(orgId, repo.fullName);
      await this.deps.store.write(orgId, (db) => {
        const r = db.repositories.find((x) => x.id === repositoryId);
        if (r) completeIndexing(db, r, Date.now(), outcome);
      });
    } catch (err) {
      if (job.attempts < job.maxAttempts) throw err;
      await this.deps.store.write(orgId, (db) => {
        const r = db.repositories.find((x) => x.id === repositoryId);
        if (r) failIndexing(db, r, (err as Error).message, Date.now());
      });
    }
  }

  /** Records that a session's stored diff exists (used by the API). */
  sessionDiff(orgId: string, sessionId: string): Promise<DiffFile[] | null> {
    return this.artifact<DiffFile[]>(orgId, "session_diff", sessionId);
  }

  runLog(orgId: string, runId: string): Promise<LogLine[] | null> {
    return this.artifact<LogLine[]>(orgId, "run_log", runId);
  }
}

/** An error whose message is safe and useful to show to the customer. */
class UserFacingError extends Error {}

function shellQuote(arg: string): string {
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

function tail(text: string, max = 600): string {
  return redactSecrets(text.trim().slice(-max)).text;
}

function diffPreview(diff: string, path: string): string {
  const start = diff.indexOf(`diff --git a/${path} `);
  if (start === -1) return "";
  const end = diff.indexOf("\ndiff --git ", start + 1);
  return redactSecrets(diff.slice(start, end === -1 ? undefined : end).slice(0, 2000)).text;
}

function prBody(
  task: { id: string; description: string; acceptanceCriteria: string[] },
  summary: string,
  agentName: string,
  appUrl: string,
): string {
  return [
    summary,
    task.acceptanceCriteria.length
      ? `### Acceptance criteria\n${task.acceptanceCriteria.map((c) => `- [ ] ${c}`).join("\n")}`
      : "",
    `---\nOpened by ${agentName} through ForgePilot ([task ${task.id}](${appUrl}/app/devpilot/tasks/${task.id})). ShipSafe verifies every commit; a person reviews and merges.`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

async function readJUnit(dir: string) {
  for (const rel of JUNIT_LOCATIONS) {
    const file = join(dir, rel);
    const info = await stat(file).catch(() => null);
    if (info?.isFile() && info.size < 20 * 1024 * 1024)
      return parseJUnit(await readFile(file, "utf8"));
  }
  return [];
}
