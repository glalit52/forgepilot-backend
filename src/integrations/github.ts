/**
 * GitHub integration: how the execution plane reaches repositories, and how
 * GitHub webhooks become lifecycle transitions.
 *
 * Webhook rules (PRD §14.4): the signature is verified and the delivery id
 * stored before acknowledging; processing happens in a job; redeliveries are
 * ignored; and the pull request's current state is re-read from the GitHub API
 * instead of trusting the payload, so out-of-order deliveries converge.
 */
import type { GithubApp, GithubIssueDto, GithubPull } from "../connectors/github";
import type { GithubIssue, PullRequest, Repository } from "../contract/schemas";
import { applyMerge, audit, startScan, startTestRun } from "../domain/loop";
import type { Database } from "../platform/db";
import { newId, toIso } from "../platform/ids";
import type { Job } from "../platform/jobs";
import type { Logger } from "../platform/logger";
import type { TenantState } from "../tenancy/state";
import { fx } from "../tenancy/state";
import type { TenantStore } from "../tenancy/store";
import type { RepoAccess } from "../execution/plane";
import type { RepoIntel } from "../execution/repoIntel";

export class GithubRepoAccess implements RepoAccess {
  constructor(
    private github: GithubApp,
    private intel: RepoIntel,
  ) {}

  async remote(orgId: string, fullName: string) {
    const installationId = await this.github.installationFor(orgId, fullName);
    return {
      url: `https://github.com/${fullName}.git`,
      token: await this.github.installationToken(installationId),
    };
  }
  async branchHead(orgId: string, fullName: string, branch: string) {
    return this.github.branchHead(
      await this.github.installationFor(orgId, fullName),
      fullName,
      branch,
    );
  }
  async openPullRequest(
    orgId: string,
    fullName: string,
    input: { title: string; head: string; base: string; body: string },
  ) {
    const pr = await this.github.openPull(
      await this.github.installationFor(orgId, fullName),
      fullName,
      input,
    );
    return { number: pr.number, url: pr.html_url };
  }
  async startCheck(
    orgId: string,
    fullName: string,
    input: { headSha: string; detailsUrl: string; summary: string },
  ) {
    return this.github.createCheckRun(
      await this.github.installationFor(orgId, fullName),
      fullName,
      {
        name: "ForgePilot ShipSafe",
        ...input,
      },
    );
  }
  async finishCheck(
    orgId: string,
    fullName: string,
    checkId: number,
    input: {
      conclusion: "success" | "failure" | "neutral";
      title: string;
      summary: string;
      detailsUrl: string;
    },
  ) {
    await this.github.completeCheckRun(
      await this.github.installationFor(orgId, fullName),
      fullName,
      checkId,
      input,
    );
  }
  async index(orgId: string, fullName: string) {
    return this.intel.index(await this.github.installationFor(orgId, fullName), fullName);
  }
  async scan(orgId: string, fullName: string, branch: string) {
    return this.intel.scan(await this.github.installationFor(orgId, fullName), fullName, branch);
  }
}

/** Maps a GitHub login to a workspace member when their profile carries it; otherwise keeps the login. */
function memberFor(db: TenantState, login: string | undefined | null): string {
  if (!login) return "github";
  return db.users.find((u) => u.githubLogin?.toLowerCase() === login.toLowerCase())?.id ?? login;
}

/** Creates or updates the workspace's record of a pull request from GitHub's canonical state. */
export function upsertPullRequest(
  db: TenantState,
  repo: Repository,
  gh: GithubPull,
  now: number,
): PullRequest {
  let pr = db.pullRequests.find((p) => p.repositoryId === repo.id && p.number === gh.number);
  const task = db.tasks.find((t) => t.repositoryId === repo.id && t.branch === gh.head.ref);
  if (!pr) {
    const session = task ? db.sessions.filter((s) => s.taskId === task.id).at(-1) : undefined;
    pr = {
      id: newId("pr"),
      orgId: repo.orgId,
      repositoryId: repo.id,
      number: gh.number,
      title: gh.title,
      url: gh.html_url,
      author:
        task && session
          ? { type: "agent", id: session.agentId, sessionId: session.id }
          : { type: "person", id: memberFor(db, gh.user?.login), sessionId: null },
      openedBy: task?.createdBy ?? memberFor(db, gh.user?.login),
      branch: gh.head.ref,
      baseSha: gh.base.sha,
      headSha: gh.head.sha,
      status: "open",
      openedAt: toIso(Date.parse(gh.created_at) || now),
      mergedAt: null,
      mergedBy: null,
      aiAuthoredPct: task ? 100 : 0,
      additions: gh.additions ?? 0,
      deletions: gh.deletions ?? 0,
      changedFiles: gh.changed_files ?? 0,
      taskId: task?.id ?? null,
      checkStatus: "queued",
      reviewers: [],
      reviewState: "review_requested",
      latestRunId: null,
    };
    db.pullRequests.push(pr);
    if (task && !task.pullRequestId) task.pullRequestId = pr.id;
    audit(
      db,
      repo.orgId,
      { type: "system", id: "github" },
      "pull_request.opened",
      `pr:${pr.id}`,
      `#${gh.number} ${gh.title}`,
      now,
    );
  }
  pr.title = gh.title;
  pr.baseSha = gh.base.sha;
  if (gh.additions !== undefined) pr.additions = gh.additions;
  if (gh.deletions !== undefined) pr.deletions = gh.deletions;
  if (gh.changed_files !== undefined) pr.changedFiles = gh.changed_files;
  return pr;
}

/** Applies GitHub's current view of a pull request: new commits re-verify, merges complete the loop. */
export function syncPullRequest(db: TenantState, repo: Repository, gh: GithubPull, now: number) {
  const pr = upsertPullRequest(db, repo, gh, now);
  if (gh.state === "closed") {
    if (gh.merged || gh.merged_at) {
      // Merge state only ever comes from GitHub; ForgePilot never merges (PRD §1.5).
      if (pr.status !== "merged") {
        pr.headSha = gh.head.sha;
        applyMerge(db, pr, memberFor(db, gh.merged_by?.login), now);
      }
    } else if (pr.status === "open") {
      pr.status = "closed";
      db.tasks
        .filter(
          (t) =>
            t.pullRequestId === pr.id && !["completed", "cancelled", "failed"].includes(t.status),
        )
        .forEach((t) => (t.status = "cancelled"));
      audit(
        db,
        repo.orgId,
        { type: "system", id: "github" },
        "pull_request.closed",
        `pr:${pr.id}`,
        `#${pr.number}`,
        now,
      );
    }
    return pr;
  }
  if (pr.status === "closed") pr.status = "open";
  const moved = pr.headSha !== gh.head.sha;
  pr.headSha = gh.head.sha;
  const verified = db.testRuns.some((r) => r.pullRequestId === pr.id && r.headSha === gh.head.sha);
  if (!verified) {
    if (moved) {
      // A new commit invalidates earlier verification and review of the old one.
      db.tasks
        .filter(
          (t) =>
            t.pullRequestId === pr.id && (t.status === "review_ready" || t.status === "failed"),
        )
        .forEach((t) => (t.status = "verifying"));
      audit(
        db,
        repo.orgId,
        { type: "system", id: "github" },
        "pull_request.synchronize",
        `pr:${pr.id}`,
        `pushed ${gh.head.sha.slice(0, 7)} to #${pr.number}`,
        now,
      );
    }
    const previous = pr.latestRunId ? db.testRuns.find((r) => r.id === pr.latestRunId) : undefined;
    startTestRun(db, repo, pr, previous ? "pull_request.synchronize" : "pull_request.opened", {
      now,
      retestOf: previous?.id ?? null,
    });
  }
  return pr;
}

export function upsertIssue(db: TenantState, repo: Repository, issue: GithubIssueDto) {
  const labels = issue.labels
    .map((l) => (typeof l === "string" ? l : (l.name ?? "")))
    .filter(Boolean);
  const existing = db.githubIssues.find(
    (i) => i.repositoryId === repo.id && i.number === issue.number,
  );
  const fields: Omit<GithubIssue, "id" | "importedTaskId"> = {
    orgId: repo.orgId,
    repositoryId: repo.id,
    number: issue.number,
    title: issue.title,
    body: (issue.body ?? "").slice(0, 20_000),
    labels,
    author: memberFor(db, issue.user?.login),
    createdAt: toIso(Date.parse(issue.created_at)),
    state: issue.state,
    url: issue.html_url,
    comments: issue.comments,
  };
  if (existing) Object.assign(existing, fields);
  else db.githubIssues.push({ id: newId("issue"), importedTaskId: null, ...fields });
}

interface Delivery {
  event: string;
  payload: Record<string, unknown>;
}

export class GithubEvents {
  constructor(private deps: { db: Database; store: TenantStore; github: GithubApp; log: Logger }) {}

  /** Stores a verified delivery. Returns false when this delivery id was already received. */
  async accept(deliveryId: string, event: string, payload: unknown): Promise<boolean> {
    return this.deps.db.tx(async (q) => {
      const res = await q.query(
        `INSERT INTO webhook_deliveries (provider, delivery_id, event, payload) VALUES ('github', $1, $2, $3::jsonb)
         ON CONFLICT DO NOTHING`,
        [deliveryId, event, JSON.stringify(payload)],
      );
      if (!res.rowCount) return false;
      await q.query(
        `INSERT INTO jobs (kind, payload, dedupe_key) VALUES ('github.webhook', $1::jsonb, $2)`,
        [JSON.stringify({ deliveryId }), `github.webhook:${deliveryId}`],
      );
      return true;
    });
  }

  async process(job: Job): Promise<void> {
    const deliveryId = String(job.payload.deliveryId);
    const { rows } = await this.deps.db.query<Delivery & { status: string }>(
      `SELECT event, payload, status FROM webhook_deliveries WHERE provider = 'github' AND delivery_id = $1`,
      [deliveryId],
    );
    const delivery = rows[0];
    if (!delivery || delivery.status === "processed") return;
    try {
      await this.handle(delivery);
      await this.deps.db.query(
        `UPDATE webhook_deliveries SET status = 'processed', processed_at = now(), error = NULL WHERE provider = 'github' AND delivery_id = $1`,
        [deliveryId],
      );
    } catch (err) {
      await this.deps.db.query(
        `UPDATE webhook_deliveries SET status = 'failed', error = $2 WHERE provider = 'github' AND delivery_id = $1`,
        [deliveryId, (err as Error).message.slice(0, 1000)],
      );
      throw err;
    }
  }

  private async handle({ event, payload }: Delivery) {
    const now = Date.now();
    const repoName = (payload.repository as { full_name?: string } | undefined)?.full_name;
    const installationId = (payload.installation as { id?: number } | undefined)?.id;
    const action = String(payload.action ?? "");

    if (
      event === "installation" &&
      installationId &&
      (action === "deleted" || action === "suspend")
    ) {
      const orgId = await this.deps.github.workspaceOfInstallation(installationId);
      if (!orgId) return;
      await this.deps.store.write(orgId, async (db, effects) => {
        const integration = db.integrations.find((i) => i.providerId === "github");
        if (integration)
          Object.assign(integration, {
            status: "error",
            error:
              action === "deleted"
                ? "The GitHub App was uninstalled. Reinstall it to keep verifying pull requests."
                : "The GitHub App installation is suspended.",
          });
        if (action === "deleted")
          await effects.q!.query(`DELETE FROM github_installations WHERE installation_id = $1`, [
            installationId,
          ]);
        audit(
          db,
          orgId,
          { type: "system", id: "github" },
          `integration.github_${action}`,
          "integration:github",
          "",
          now,
        );
      });
      return;
    }
    if (!repoName) return;
    const targets = await this.deps.github.workspacesFor(repoName);
    if (!targets.length) return;

    // Read GitHub's current state once, outside any workspace transaction.
    let pull: GithubPull | null = null;
    if (event === "pull_request" || event === "pull_request_review") {
      const number = (payload.pull_request as { number?: number } | undefined)?.number;
      if (!number || !installationId) return;
      pull = await this.deps.github.getPull(installationId, repoName, number);
    }

    for (const target of targets)
      await this.deps.store.write(target.orgId, (db) => {
        const repo = db.repositories.find((r) => r.id === target.repositoryId);
        if (!repo) return;
        if (event === "pull_request" && pull) syncPullRequest(db, repo, pull, now);
        else if (event === "pull_request_review" && pull && action === "submitted") {
          const review = payload.review as
            { state?: string; user?: { login?: string } } | undefined;
          const pr = upsertPullRequest(db, repo, pull, now);
          const state = review?.state?.toLowerCase();
          if (state === "approved" || state === "changes_requested") {
            pr.reviewState = state;
            const reviewer = memberFor(db, review?.user?.login);
            if (!pr.reviewers.includes(reviewer)) pr.reviewers.push(reviewer);
            audit(
              db,
              repo.orgId,
              { type: "system", id: "github" },
              "pull_request.reviewed",
              `pr:${pr.id}`,
              state.replace("_", " "),
              now,
            );
          }
        } else if (event === "push") {
          const ref = String(payload.ref ?? "");
          const after = String(payload.after ?? "");
          if (ref !== `refs/heads/${repo.defaultBranch}` || !/^[0-9a-f]{40}$/.test(after)) return;
          repo.indexedSha = after;
          repo.indexedAt = toIso(now);
          fx(db).enqueue({
            kind: "repo.index",
            payload: { repositoryId: repo.id },
            dedupeKey: `repo.index:${repo.orgId}:${repo.id}`,
          });
          const scanning = db.scans.some(
            (s) => s.repositoryId === repo.id && s.status === "running",
          );
          if (repo.scanSchedule === "on_push" && !scanning) startScan(db, repo, "push", now);
        } else if (event === "issues") {
          const issue = payload.issue as GithubIssueDto | undefined;
          if (issue && !issue.pull_request) upsertIssue(db, repo, issue);
        }
      });
  }

  /** Mirrors a repository's open issues so they can be imported as tasks. */
  async syncIssues(job: Job): Promise<void> {
    const orgId = job.orgId!;
    const repositoryId = String(job.payload.repositoryId);
    const repo = (await this.deps.store.read(orgId)).repositories.find(
      (r) => r.id === repositoryId,
    );
    if (!repo) return;
    const installationId = await this.deps.github.installationFor(orgId, repo.fullName);
    const issues = await this.deps.github.openIssues(installationId, repo.fullName);
    await this.deps.store.write(orgId, (db) => {
      const r = db.repositories.find((x) => x.id === repositoryId);
      if (!r) return;
      const open = new Set(issues.map((i) => i.number));
      issues.forEach((i) => upsertIssue(db, r, i));
      // Issues that are no longer open on GitHub were closed there.
      db.githubIssues
        .filter((i) => i.repositoryId === r.id && i.state === "open" && !open.has(i.number))
        .forEach((i) => (i.state = "closed"));
    });
  }
}
