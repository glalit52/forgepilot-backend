/**
 * Git operations for execution workspaces. The repository token is passed per
 * command as an HTTP header and is never written to the clone's config, so
 * code running inside the workspace (agents, tests) cannot read it.
 */
import { mkdir, rm } from "node:fs/promises";
import { runProcess, type RunResult } from "./sandbox";

export interface GitAuth {
  /** Short-lived installation token, or null for a local/public remote. */
  token: string | null;
}

export class GitError extends Error {
  constructor(
    message: string,
    public output: string,
  ) {
    super(message);
  }
}

function authArgs(auth: GitAuth): string[] {
  if (!auth.token) return [];
  const basic = Buffer.from(`x-access-token:${auth.token}`).toString("base64");
  return ["-c", `http.extraheader=AUTHORIZATION: basic ${basic}`];
}

async function git(
  cwd: string,
  args: string[],
  auth: GitAuth = { token: null },
  timeoutMs = 120_000,
): Promise<RunResult> {
  // Repository-provided hooks and config must never execute on the worker host.
  const res = await runProcess(
    "git",
    ["-c", "core.hooksPath=/dev/null", ...authArgs(auth), ...args],
    {
      cwd,
      timeoutMs,
      env: {
        GIT_TERMINAL_PROMPT: "0",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        HOME: "/nonexistent",
        GIT_AUTHOR_NAME: "ForgePilot Agent",
        GIT_AUTHOR_EMAIL: "agent@forgepilot.dev",
        GIT_COMMITTER_NAME: "ForgePilot Agent",
        GIT_COMMITTER_EMAIL: "agent@forgepilot.dev",
      },
    },
  );
  if (res.code !== 0) {
    const safe = auth.token ? res.output.split(auth.token).join("[REDACTED]") : res.output;
    throw new GitError(
      `git ${args[0]} failed${res.timedOut ? " (timed out)" : ""}`,
      safe.slice(-2000),
    );
  }
  return res;
}

export interface ChangeSummary {
  files: { path: string; additions: number; deletions: number }[];
  diff: string;
}

export class GitWorkspace {
  constructor(
    readonly dir: string,
    private remoteUrl: string,
    private auth: GitAuth,
  ) {}

  /** Fresh clone of one branch. */
  async clone(branch: string): Promise<void> {
    await rm(this.dir, { recursive: true, force: true });
    await mkdir(this.dir, { recursive: true });
    await git(
      this.dir,
      ["clone", "--depth", "50", "--no-tags", "--branch", branch, this.remoteUrl, "."],
      this.auth,
      300_000,
    );
  }

  /** Fresh checkout of one exact commit (commit-pinned verification). */
  async checkoutCommit(sha: string): Promise<void> {
    await rm(this.dir, { recursive: true, force: true });
    await mkdir(this.dir, { recursive: true });
    await git(this.dir, ["init", "--quiet"]);
    await git(this.dir, ["remote", "add", "origin", this.remoteUrl]);
    await git(this.dir, ["fetch", "--depth", "1", "--no-tags", "origin", sha], this.auth, 300_000);
    await git(this.dir, ["checkout", "--quiet", "FETCH_HEAD"]);
  }

  async head(): Promise<string> {
    return (await git(this.dir, ["rev-parse", "HEAD"])).output.trim();
  }

  async createBranch(name: string): Promise<void> {
    await git(this.dir, ["checkout", "--quiet", "-B", name]);
  }

  /** Stages everything and reports what changed relative to HEAD. */
  async stagedChanges(): Promise<ChangeSummary> {
    await git(this.dir, ["add", "--all"]);
    const numstat = (await git(this.dir, ["diff", "--cached", "--numstat"])).output;
    const files = numstat
      .split("\n")
      .map((l) => l.split("\t"))
      .filter((p) => p.length === 3)
      .map(([add, del, path]) => ({
        path,
        // Binary files report "-" for both counts.
        additions: Number(add) || 0,
        deletions: Number(del) || 0,
      }));
    const diff = files.length
      ? (await git(this.dir, ["diff", "--cached", "--no-color"])).output
      : "";
    return { files, diff };
  }

  async commit(message: string): Promise<string> {
    await git(this.dir, ["commit", "--quiet", "--no-verify", "-m", message]);
    return this.head();
  }

  async push(branch: string): Promise<void> {
    await git(
      this.dir,
      ["push", "--quiet", "origin", `HEAD:refs/heads/${branch}`],
      this.auth,
      300_000,
    );
  }

  async destroy(): Promise<void> {
    await rm(this.dir, { recursive: true, force: true });
  }
}
