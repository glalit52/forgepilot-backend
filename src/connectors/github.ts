/**
 * GitHub App connector. Authenticates as the app (RS256 JWT) to mint
 * short-lived installation tokens scoped to the repositories the customer
 * chose; nothing long-lived is ever stored for a repository.
 */
import { createSign } from "node:crypto";
import type { DiffFile, DiffLine } from "../contract/schemas";
import { hmacSha256, safeEqual } from "../platform/crypto";
import type { Database, Queryable } from "../platform/db";
import { HttpError } from "../platform/errors";
import { ConnectorError, requestJson, type FetchLike } from "./http";

export interface GithubConfig {
  appId?: string;
  appSlug?: string;
  privateKey?: string;
  webhookSecret?: string;
  oauthClientId?: string;
  oauthClientSecret?: string;
  apiUrl: string;
}

export interface GithubRepo {
  full_name: string;
  private: boolean;
  language: string | null;
  default_branch: string;
  pushed_at: string | null;
  html_url: string;
}

export interface GithubPull {
  number: number;
  title: string;
  html_url: string;
  state: "open" | "closed";
  merged?: boolean;
  merged_at: string | null;
  created_at: string;
  additions?: number;
  deletions?: number;
  changed_files?: number;
  user: { login: string; type?: string } | null;
  merged_by?: { login: string } | null;
  head: { ref: string; sha: string };
  base: { ref: string; sha: string };
}

export interface GithubIssueDto {
  number: number;
  title: string;
  body: string | null;
  state: "open" | "closed";
  html_url: string;
  comments: number;
  created_at: string;
  user: { login: string } | null;
  labels: ({ name?: string } | string)[];
  pull_request?: unknown;
}

const b64url = (v: string | Buffer) => Buffer.from(v).toString("base64url");

/** GitHub signs webhook bodies with HMAC-SHA256; compare in constant time over the raw bytes. */
export function verifyGithubSignature(
  secret: string,
  rawBody: Buffer,
  header: string | undefined,
): boolean {
  if (!header?.startsWith("sha256=")) return false;
  return safeEqual(`sha256=${hmacSha256(secret, rawBody)}`, header);
}

/** Converts a unified diff hunk list ("patch" from the GitHub API) into numbered lines. */
export function parsePatch(patch: string | undefined): DiffLine[] {
  if (!patch) return [];
  const lines: DiffLine[] = [];
  let oldNo = 0;
  let newNo = 0;
  for (const raw of patch.split("\n")) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (hunk) {
      oldNo = Number(hunk[1]);
      newNo = Number(hunk[2]);
      lines.push({ kind: "hunk", oldNo: null, newNo: null, text: raw });
    } else if (raw.startsWith("+"))
      lines.push({ kind: "add", oldNo: null, newNo: newNo++, text: raw.slice(1) });
    else if (raw.startsWith("-"))
      lines.push({ kind: "del", oldNo: oldNo++, newNo: null, text: raw.slice(1) });
    else if (raw.startsWith("\\"))
      continue; // "\ No newline at end of file"
    else lines.push({ kind: "context", oldNo: oldNo++, newNo: newNo++, text: raw.slice(1) });
  }
  return lines;
}

/** Parses `git diff` output (several files) into the API's diff shape. */
export function parseUnifiedDiff(diff: string, aiAuthored: boolean): DiffFile[] {
  const files: DiffFile[] = [];
  for (const chunk of diff.split(/^diff --git /m).slice(1)) {
    const header = /^a\/(.+?) b\/(.+?)\n/.exec(chunk);
    if (!header) continue;
    const status = /^new file mode/m.test(chunk)
      ? "added"
      : /^deleted file mode/m.test(chunk)
        ? "deleted"
        : "modified";
    const at = chunk.indexOf("\n@@ ");
    const lines = at === -1 ? [] : parsePatch(chunk.slice(at + 1).replace(/\n$/, ""));
    files.push({
      path: status === "deleted" ? header[1] : header[2],
      status,
      additions: lines.filter((l) => l.kind === "add").length,
      deletions: lines.filter((l) => l.kind === "del").length,
      aiAuthored,
      lines: lines.slice(0, 2_000),
    });
  }
  return files;
}

export class GithubApp {
  private tokens = new Map<number, { token: string; expiresAt: number }>();

  constructor(
    private cfg: GithubConfig,
    private fetchImpl: FetchLike,
    private db: Database,
  ) {}

  get configured(): boolean {
    return !!(this.cfg.appId && this.cfg.privateKey);
  }

  get installUrl(): string | null {
    return this.cfg.appSlug
      ? `https://github.com/apps/${this.cfg.appSlug}/installations/new`
      : null;
  }

  private appJwt(now = Date.now()): string {
    if (!this.cfg.appId || !this.cfg.privateKey)
      throw new HttpError(503, "The GitHub App is not configured");
    const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
    // Issued 60s in the past to tolerate clock drift; GitHub caps lifetime at 10 minutes.
    const iat = Math.floor(now / 1000) - 60;
    const payload = b64url(JSON.stringify({ iat, exp: iat + 600, iss: this.cfg.appId }));
    const signature = createSign("RSA-SHA256")
      .update(`${header}.${payload}`)
      .sign(this.cfg.privateKey);
    return `${header}.${payload}.${b64url(signature)}`;
  }

  private headers(token: string): Record<string, string> {
    return {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "forgepilot-backend",
    };
  }

  private asApp<T>(method: string, path: string, body?: unknown): Promise<T> {
    return requestJson<T>(this.fetchImpl, "github", `${this.cfg.apiUrl}${path}`, {
      method,
      body,
      headers: this.headers(this.appJwt()),
    });
  }

  /** Installation tokens live one hour; cached until five minutes before expiry. */
  async installationToken(installationId: number): Promise<string> {
    const cached = this.tokens.get(installationId);
    if (cached && cached.expiresAt - Date.now() > 5 * 60_000) return cached.token;
    const res = await this.asApp<{ token: string; expires_at: string }>(
      "POST",
      `/app/installations/${installationId}/access_tokens`,
    );
    this.tokens.set(installationId, { token: res.token, expiresAt: Date.parse(res.expires_at) });
    return res.token;
  }

  async api<T>(installationId: number, method: string, path: string, body?: unknown): Promise<T> {
    return requestJson<T>(this.fetchImpl, "github", `${this.cfg.apiUrl}${path}`, {
      method,
      body,
      headers: this.headers(await this.installationToken(installationId)),
    });
  }

  // ---------------------------------------------------------------- installations
  async getInstallation(installationId: number): Promise<{ account: string }> {
    try {
      const res = await this.asApp<{ account: { login: string } | null }>(
        "GET",
        `/app/installations/${installationId}`,
      );
      return { account: res.account?.login ?? String(installationId) };
    } catch (err) {
      if (err instanceof ConnectorError && err.status === 404)
        throw new HttpError(404, "That GitHub App installation was not found");
      throw err;
    }
  }

  async linkInstallation(q: Queryable, orgId: string, installationId: number, account: string) {
    const owner = await q.query<{ org_id: string }>(
      `SELECT org_id FROM github_installations WHERE installation_id = $1`,
      [installationId],
    );
    // One installation belongs to one workspace: otherwise its repositories would be visible to two tenants.
    if (owner.rows[0] && owner.rows[0].org_id !== orgId)
      throw new HttpError(409, "This GitHub installation is already linked to another workspace");
    await q.query(
      `INSERT INTO github_installations (installation_id, org_id, account_login) VALUES ($1, $2, $3)
       ON CONFLICT (installation_id) DO UPDATE SET account_login = EXCLUDED.account_login`,
      [installationId, orgId, account],
    );
  }

  async unlinkInstallations(q: Queryable, orgId: string) {
    await q.query(`DELETE FROM github_installations WHERE org_id = $1`, [orgId]);
    await q.query(`UPDATE repository_links SET installation_id = NULL WHERE org_id = $1`, [orgId]);
  }

  async installationsOf(orgId: string): Promise<number[]> {
    const { rows } = await this.db.query<{ installation_id: number }>(
      `SELECT installation_id FROM github_installations WHERE org_id = $1 ORDER BY created_at`,
      [orgId],
    );
    return rows.map((r) => Number(r.installation_id));
  }

  /** The installation that can reach `fullName` for this workspace. */
  async installationFor(orgId: string, fullName: string): Promise<number> {
    const linked = await this.db.query<{ installation_id: number | null }>(
      `SELECT installation_id FROM repository_links WHERE provider = 'github' AND full_name_lower = lower($1) AND org_id = $2`,
      [fullName, orgId],
    );
    if (linked.rows[0]?.installation_id) return Number(linked.rows[0].installation_id);
    const owner = fullName.split("/")[0]?.toLowerCase();
    const { rows } = await this.db.query<{ installation_id: number; account_login: string }>(
      `SELECT installation_id, account_login FROM github_installations WHERE org_id = $1 ORDER BY created_at`,
      [orgId],
    );
    const match = rows.find((r) => r.account_login.toLowerCase() === owner) ?? rows[0];
    if (!match) throw new HttpError(409, "Install the GitHub App for this workspace first");
    return Number(match.installation_id);
  }

  async linkRepository(q: Queryable, orgId: string, repositoryId: string, fullName: string) {
    const owner = fullName.split("/")[0]?.toLowerCase();
    const inst = await q.query<{ installation_id: number }>(
      `SELECT installation_id FROM github_installations WHERE org_id = $1 AND lower(account_login) = $2 LIMIT 1`,
      [orgId, owner],
    );
    await q.query(
      `INSERT INTO repository_links (provider, full_name_lower, org_id, repository_id, installation_id)
       VALUES ('github', lower($1), $2, $3, $4)
       ON CONFLICT (provider, full_name_lower, org_id)
       DO UPDATE SET repository_id = EXCLUDED.repository_id, installation_id = EXCLUDED.installation_id`,
      [fullName, orgId, repositoryId, inst.rows[0]?.installation_id ?? null],
    );
  }

  /** Workspaces that connected this repository (a webhook for it fans out to each). */
  async workspacesFor(fullName: string): Promise<{ orgId: string; repositoryId: string }[]> {
    const { rows } = await this.db.query<{ org_id: string; repository_id: string }>(
      `SELECT org_id, repository_id FROM repository_links WHERE provider = 'github' AND full_name_lower = lower($1)`,
      [fullName],
    );
    return rows.map((r) => ({ orgId: r.org_id, repositoryId: r.repository_id }));
  }

  async workspaceOfInstallation(installationId: number): Promise<string | null> {
    const { rows } = await this.db.query<{ org_id: string }>(
      `SELECT org_id FROM github_installations WHERE installation_id = $1`,
      [installationId],
    );
    return rows[0]?.org_id ?? null;
  }

  // ---------------------------------------------------------------- repositories
  async listRepositories(orgId: string): Promise<GithubRepo[]> {
    const out: GithubRepo[] = [];
    for (const installationId of await this.installationsOf(orgId))
      for (let page = 1; page <= 10; page++) {
        const res = await this.api<{ repositories: GithubRepo[] }>(
          installationId,
          "GET",
          `/installation/repositories?per_page=100&page=${page}`,
        );
        out.push(...res.repositories);
        if (res.repositories.length < 100) break;
      }
    return out;
  }

  private repoPath(fullName: string): string {
    if (!/^[\w.-]+\/[\w.-]+$/.test(fullName))
      throw new HttpError(422, `"${fullName}" is not a valid repository name`);
    return `/repos/${fullName}`;
  }

  async getRepository(installationId: number, fullName: string): Promise<GithubRepo> {
    try {
      return await this.api<GithubRepo>(installationId, "GET", this.repoPath(fullName));
    } catch (err) {
      if (err instanceof ConnectorError && (err.status === 404 || err.status === 403))
        throw new HttpError(
          404,
          `The GitHub App can't access ${fullName}. Add it to the installation first.`,
        );
      throw err;
    }
  }

  async branchHead(installationId: number, fullName: string, branch: string): Promise<string> {
    const res = await this.api<{ commit: { sha: string } }>(
      installationId,
      "GET",
      `${this.repoPath(fullName)}/branches/${encodeURIComponent(branch)}`,
    );
    return res.commit.sha;
  }

  /** File content at a ref, or null when the file does not exist. */
  async fileContent(
    installationId: number,
    fullName: string,
    path: string,
    ref: string,
  ): Promise<string | null> {
    try {
      const res = await this.api<{ content?: string; encoding?: string; type?: string }>(
        installationId,
        "GET",
        `${this.repoPath(fullName)}/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(ref)}`,
      );
      if (res.type !== "file" || res.encoding !== "base64" || res.content === undefined)
        return null;
      return Buffer.from(res.content, "base64").toString("utf8");
    } catch (err) {
      if (err instanceof ConnectorError && err.status === 404) return null;
      throw err;
    }
  }

  async tree(
    installationId: number,
    fullName: string,
    sha: string,
  ): Promise<{ paths: string[]; truncated: boolean }> {
    const res = await this.api<{ tree: { path: string; type: string }[]; truncated: boolean }>(
      installationId,
      "GET",
      `${this.repoPath(fullName)}/git/trees/${sha}?recursive=1`,
    );
    return {
      paths: res.tree.filter((t) => t.type === "blob").map((t) => t.path),
      truncated: res.truncated,
    };
  }

  languages(installationId: number, fullName: string): Promise<Record<string, number>> {
    return this.api(installationId, "GET", `${this.repoPath(fullName)}/languages`);
  }

  async openIssues(installationId: number, fullName: string): Promise<GithubIssueDto[]> {
    const res = await this.api<GithubIssueDto[]>(
      installationId,
      "GET",
      `${this.repoPath(fullName)}/issues?state=open&per_page=100&sort=created&direction=desc`,
    );
    // The issues API also returns pull requests; those are tracked separately.
    return res.filter((i) => !i.pull_request);
  }

  // ---------------------------------------------------------------- pull requests & checks
  getPull(installationId: number, fullName: string, number: number): Promise<GithubPull> {
    return this.api(installationId, "GET", `${this.repoPath(fullName)}/pulls/${number}`);
  }

  async openPull(
    installationId: number,
    fullName: string,
    input: { title: string; head: string; base: string; body: string },
  ): Promise<GithubPull> {
    try {
      return await this.api<GithubPull>(
        installationId,
        "POST",
        `${this.repoPath(fullName)}/pulls`,
        input,
      );
    } catch (err) {
      // A retry after a lost response: the PR for this branch already exists.
      if (err instanceof ConnectorError && err.status === 422) {
        const owner = fullName.split("/")[0];
        const existing = await this.api<GithubPull[]>(
          installationId,
          "GET",
          `${this.repoPath(fullName)}/pulls?head=${encodeURIComponent(`${owner}:${input.head}`)}&state=open`,
        );
        if (existing[0]) return existing[0];
      }
      throw err;
    }
  }

  async pullFiles(installationId: number, fullName: string, number: number): Promise<DiffFile[]> {
    const res = await this.api<
      { filename: string; status: string; additions: number; deletions: number; patch?: string }[]
    >(installationId, "GET", `${this.repoPath(fullName)}/pulls/${number}/files?per_page=100`);
    return res.map((f) => ({
      path: f.filename,
      status: f.status === "added" ? "added" : f.status === "removed" ? "deleted" : "modified",
      additions: f.additions,
      deletions: f.deletions,
      aiAuthored: false,
      lines: parsePatch(f.patch).slice(0, 2_000),
    }));
  }

  async createCheckRun(
    installationId: number,
    fullName: string,
    input: { name: string; headSha: string; detailsUrl: string; summary: string },
  ): Promise<number> {
    const res = await this.api<{ id: number }>(
      installationId,
      "POST",
      `${this.repoPath(fullName)}/check-runs`,
      {
        name: input.name,
        head_sha: input.headSha,
        status: "in_progress",
        details_url: input.detailsUrl,
        output: { title: input.name, summary: input.summary },
      },
    );
    return res.id;
  }

  async completeCheckRun(
    installationId: number,
    fullName: string,
    checkRunId: number,
    input: {
      conclusion: "success" | "failure" | "neutral";
      title: string;
      summary: string;
      detailsUrl: string;
    },
  ) {
    await this.api(installationId, "PATCH", `${this.repoPath(fullName)}/check-runs/${checkRunId}`, {
      status: "completed",
      conclusion: input.conclusion,
      details_url: input.detailsUrl,
      output: { title: input.title, summary: input.summary.slice(0, 60_000) },
    });
  }

  /** HTTPS clone URL carrying a one-hour token. Never log it. */
  async cloneUrl(
    installationId: number,
    fullName: string,
  ): Promise<{ url: string; token: string }> {
    const token = await this.installationToken(installationId);
    return { url: `https://x-access-token:${token}@github.com/${fullName}.git`, token };
  }

  // ---------------------------------------------------------------- OAuth (sign in with GitHub)
  get oauthConfigured(): boolean {
    return !!(this.cfg.oauthClientId && this.cfg.oauthClientSecret);
  }

  authorizeUrl(state: string, redirectUri: string): string {
    const q = new URLSearchParams({
      client_id: this.cfg.oauthClientId ?? "",
      redirect_uri: redirectUri,
      scope: "read:user user:email",
      state,
    });
    return `https://github.com/login/oauth/authorize?${q}`;
  }

  /** Exchanges the OAuth code and returns the GitHub user with a verified primary email. */
  async oauthUser(
    code: string,
    redirectUri: string,
  ): Promise<{ id: string; login: string; name: string; email: string }> {
    const token = await requestJson<{ access_token?: string; error_description?: string }>(
      this.fetchImpl,
      "github",
      "https://github.com/login/oauth/access_token",
      {
        method: "POST",
        body: {
          client_id: this.cfg.oauthClientId,
          client_secret: this.cfg.oauthClientSecret,
          code,
          redirect_uri: redirectUri,
        },
      },
    );
    if (!token.access_token)
      throw new HttpError(401, token.error_description ?? "GitHub sign-in failed");
    const headers = this.headers(token.access_token);
    const user = await requestJson<{ id: number; login: string; name: string | null }>(
      this.fetchImpl,
      "github",
      `${this.cfg.apiUrl}/user`,
      { headers },
    );
    const emails = await requestJson<{ email: string; primary: boolean; verified: boolean }[]>(
      this.fetchImpl,
      "github",
      `${this.cfg.apiUrl}/user/emails`,
      { headers },
    );
    // Only a verified address may be used to match an existing account.
    const email = emails.find((e) => e.primary && e.verified) ?? emails.find((e) => e.verified);
    if (!email) throw new HttpError(403, "Your GitHub account has no verified email address");
    return {
      id: String(user.id),
      login: user.login,
      name: user.name ?? user.login,
      email: email.email,
    };
  }
}
