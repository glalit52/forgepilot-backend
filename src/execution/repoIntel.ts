/**
 * Repository intelligence over the GitHub API: the indexer (what is this
 * repository?) and the CodeKeeper scanner (what needs maintenance?). Both read
 * exact files at an exact commit; nothing is cloned or executed.
 */
import type { AdvisoryClient, Ecosystem, PackageRef } from "../connectors/advisories";
import type { GithubApp } from "../connectors/github";
import { mapLimit } from "../connectors/http";
import type { IndexOutcome, ScanOutcome } from "../domain/loop";
import {
  detectFrameworks,
  detectTestCommands,
  parsePackageJson,
  parsePackageLock,
  parseRequirements,
  versionFromRange,
  type PackageJson,
  type PinnedRequirement,
} from "./manifests";

const IGNORED = /(^|\/)(node_modules|vendor|dist|build|\.venv|venv|site-packages)\//;
const MAX_MANIFESTS = 12;
const MAX_REGISTRY_LOOKUPS = 250;
const MAX_OSV_PACKAGES = 3_000;

export class RepoIntel {
  constructor(
    private github: GithubApp,
    private advisories: AdvisoryClient,
  ) {}

  private async manifests(installationId: number, fullName: string, sha: string) {
    const { paths } = await this.github.tree(installationId, fullName, sha);
    const kept = paths.filter((p) => !IGNORED.test(p));
    const byDepth = (a: string, b: string) =>
      a.split("/").length - b.split("/").length || a.localeCompare(b);
    const packageJsons = kept
      .filter((p) => /(^|\/)package\.json$/.test(p))
      .sort(byDepth)
      .slice(0, MAX_MANIFESTS);
    const requirements = kept
      .filter((p) => /(^|\/)requirements[^/]*\.txt$/.test(p))
      .sort(byDepth)
      .slice(0, MAX_MANIFESTS);
    const read = (path: string) => this.github.fileContent(installationId, fullName, path, sha);
    const node = (
      await mapLimit(packageJsons, 4, async (path) => {
        const pkg = parsePackageJson((await read(path)) ?? "");
        if (!pkg) return null;
        const lockPath = path.replace(/package\.json$/, "package-lock.json");
        const lock = kept.includes(lockPath)
          ? parsePackageLock((await read(lockPath)) ?? "")
          : new Map<string, string>();
        return { path, pkg, lock };
      })
    ).filter((x): x is { path: string; pkg: PackageJson; lock: Map<string, string> } => !!x);
    const python = await mapLimit(requirements, 4, async (path) => ({
      path,
      requirements: parseRequirements((await read(path)) ?? ""),
    }));
    return { paths: kept, node, python };
  }

  async index(installationId: number, fullName: string): Promise<IndexOutcome> {
    const repo = await this.github.getRepository(installationId, fullName);
    const headSha = await this.github.branchHead(installationId, fullName, repo.default_branch);
    const [languages, m] = await Promise.all([
      this.github.languages(installationId, fullName),
      this.manifests(installationId, fullName, headSha),
    ]);
    const nodeNames = m.node.flatMap((n) => n.pkg.dependencies.map((d) => d.name));
    const pyReqs: PinnedRequirement[] = m.python.flatMap((p) => p.requirements);
    const ecosystems: Ecosystem[] = [];
    if (m.node.length) ecosystems.push("npm");
    if (m.python.length) ecosystems.push("pypi");
    return {
      defaultBranch: repo.default_branch,
      private: repo.private,
      headSha,
      languages: Object.entries(languages)
        .sort(([, a], [, b]) => b - a)
        .slice(0, 5)
        .map(([name]) => name.toLowerCase()),
      frameworks: detectFrameworks(
        nodeNames,
        pyReqs.map((r) => r.name),
      ),
      ecosystems,
      testCommands: detectTestCommands(m.node[0]?.pkg ?? null, pyReqs, m.paths),
      ciWorkflows: m.paths
        .filter((p) => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(p))
        .map((p) => p.split("/").pop()!),
      fileCount: m.paths.length,
      hasDocs: m.paths.some((p) => /^readme(\.[a-z]+)?$/i.test(p) || /^docs\//i.test(p)),
    };
  }

  async scan(installationId: number, fullName: string, branch: string): Promise<ScanOutcome> {
    const commitSha = await this.github.branchHead(installationId, fullName, branch);
    const m = await this.manifests(installationId, fullName, commitSha);

    interface Found extends PackageRef {
      direct: boolean;
      manifest: string;
    }
    const found = new Map<string, Found>();
    const add = (f: Found) => {
      const key = `${f.ecosystem}:${f.name}:${f.manifest}`;
      if (!found.has(key)) found.set(key, f);
    };
    for (const n of m.node) {
      const direct = new Set(n.pkg.dependencies.map((d) => d.name));
      for (const d of n.pkg.dependencies) {
        const version = n.lock.get(d.name) ?? versionFromRange(d.range);
        if (version)
          add({ ecosystem: "npm", name: d.name, version, direct: true, manifest: n.path });
      }
      // Transitive packages come from the lockfile: that is where most advisories land.
      for (const [name, version] of n.lock)
        if (!direct.has(name))
          add({
            ecosystem: "npm",
            name,
            version,
            direct: false,
            manifest: n.path.replace(/package\.json$/, "package-lock.json"),
          });
    }
    for (const p of m.python)
      for (const r of p.requirements)
        if (r.version)
          add({
            ecosystem: "pypi",
            name: r.name,
            version: r.version,
            direct: true,
            manifest: p.path,
          });

    const all = [...found.values()];
    const directs = all.filter((f) => f.direct).slice(0, MAX_REGISTRY_LOOKUPS);
    const latest = new Map<string, { version: string; license: string }>();
    await mapLimit(directs, 8, async (f) => {
      const info = await this.advisories.latest(f.ecosystem, f.name);
      if (info) latest.set(`${f.ecosystem}:${f.name}`, info);
    });
    const advisories = await this.advisories.vulnerabilities(
      all
        .slice(0, MAX_OSV_PACKAGES)
        .map(({ ecosystem, name, version }) => ({ ecosystem, name, version })),
    );
    const pyReqs = m.python.flatMap((p) => p.requirements);
    return {
      commitSha,
      dependencies: all.map((f) => {
        const info = latest.get(`${f.ecosystem}:${f.name}`);
        return {
          ecosystem: f.ecosystem,
          name: f.name,
          installedVersion: f.version,
          // Unknown latest is reported as "same as installed", never as a made-up newer version.
          latestVersion: info?.version ?? f.version,
          direct: f.direct,
          license: info?.license ?? "Unknown",
          manifest: f.manifest,
        };
      }),
      advisories: advisories.map((a) => ({
        ecosystem: a.ecosystem,
        package: a.name,
        installedVersion: a.version,
        fixedVersion: a.fixedVersion,
        advisoryId: a.advisoryId,
        source: a.source,
        sourceUrl: a.sourceUrl,
        severity: a.severity,
        title: a.title,
      })),
      signals: {
        hasDocs: m.paths.some((p) => /^readme(\.[a-z]+)?$/i.test(p) || /^docs\//i.test(p)),
        hasCi: m.paths.some((p) => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(p)),
        hasTests: detectTestCommands(m.node[0]?.pkg ?? null, pyReqs, m.paths).length > 0,
      },
    };
  }
}
