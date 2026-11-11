/** Pure parsers for dependency manifests. No I/O, so they are easy to test against real-world files. */

export interface DeclaredDependency {
  name: string;
  /** Version range as written in the manifest. */
  range: string;
  dev: boolean;
}

export interface PackageJson {
  dependencies: DeclaredDependency[];
  scripts: Record<string, string>;
}

export function parsePackageJson(text: string): PackageJson | null {
  let json: {
    dependencies?: Record<string, unknown>;
    devDependencies?: Record<string, unknown>;
    scripts?: Record<string, unknown>;
  };
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  if (!json || typeof json !== "object") return null;
  const collect = (group: Record<string, unknown> | undefined, dev: boolean) =>
    Object.entries(group ?? {})
      .filter((e): e is [string, string] => typeof e[1] === "string")
      // Local and git references have no registry version to compare against.
      .filter(([, range]) => !/^(file:|link:|workspace:|git\+|github:|https?:)/.test(range))
      .map(([name, range]) => ({ name, range, dev }));
  return {
    dependencies: [...collect(json.dependencies, false), ...collect(json.devDependencies, true)],
    scripts: Object.fromEntries(
      Object.entries(json.scripts ?? {}).filter(
        (e): e is [string, string] => typeof e[1] === "string",
      ),
    ),
  };
}

/** Exact installed versions from package-lock.json (v2/v3 `packages`, v1 `dependencies`). */
export function parsePackageLock(text: string): Map<string, string> {
  const out = new Map<string, string>();
  let json: {
    packages?: Record<string, { version?: string; link?: boolean }>;
    dependencies?: Record<string, { version?: string }>;
  };
  try {
    json = JSON.parse(text);
  } catch {
    return out;
  }
  if (json.packages) {
    for (const [path, entry] of Object.entries(json.packages)) {
      if (!path || entry.link || !entry.version) continue;
      const name = path.slice(path.lastIndexOf("node_modules/") + "node_modules/".length);
      // Hoisted (top-level) entries win: that is the copy the project itself resolves.
      const topLevel = path === `node_modules/${name}`;
      if (topLevel || !out.has(name)) out.set(name, entry.version);
    }
  } else if (json.dependencies) {
    for (const [name, entry] of Object.entries(json.dependencies))
      if (entry.version) out.set(name, entry.version);
  }
  return out;
}

/** Best exact version for a semver range when no lockfile is available ("^4.17.1" → "4.17.1"). */
export function versionFromRange(range: string): string | null {
  const m = /(\d+)(?:\.(\d+))?(?:\.(\d+))?([-+][0-9A-Za-z.-]+)?/.exec(range);
  if (!m) return null;
  return `${m[1]}.${m[2] ?? "0"}.${m[3] ?? "0"}${m[4] ?? ""}`;
}

export interface PinnedRequirement {
  name: string;
  /** Only exact pins (`==`) are known versions; anything else is null. */
  version: string | null;
}

export function parseRequirements(text: string): PinnedRequirement[] {
  const out: PinnedRequirement[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$/, "").trim();
    if (
      !line ||
      line.startsWith("#") ||
      line.startsWith("-") ||
      /^(https?:|git\+|\.|\/)/.test(line)
    )
      continue;
    const m =
      /^([A-Za-z0-9][A-Za-z0-9._-]*)(?:\[[^\]]*\])?\s*(?:(==|===)\s*([A-Za-z0-9.!+*_-]+))?/.exec(
        line.split(";")[0],
      );
    if (!m) continue;
    // PEP 503 normalisation: registries treat -, _ and . as the same character.
    out.push({
      name: m[1].toLowerCase().replace(/[-_.]+/g, "-"),
      version: m[3] && !m[3].includes("*") ? m[3] : null,
    });
  }
  return out;
}

const NODE_FRAMEWORKS: [RegExp, string][] = [
  [/^next$/, "Next.js"],
  [/^react$/, "React"],
  [/^vue$/, "Vue"],
  [/^svelte$|^@sveltejs\/kit$/, "Svelte"],
  [/^@angular\/core$/, "Angular"],
  [/^express$/, "Express"],
  [/^fastify$/, "Fastify"],
  [/^@nestjs\/core$/, "NestJS"],
  [/^hono$/, "Hono"],
];
const PYTHON_FRAMEWORKS: [RegExp, string][] = [
  [/^fastapi$/, "FastAPI"],
  [/^django$/, "Django"],
  [/^flask$/, "Flask"],
];

export function detectFrameworks(node: string[], python: string[]): string[] {
  const found: string[] = [];
  for (const [re, label] of NODE_FRAMEWORKS) if (node.some((n) => re.test(n))) found.push(label);
  for (const [re, label] of PYTHON_FRAMEWORKS)
    if (python.some((n) => re.test(n))) found.push(label);
  return found;
}

/** Test commands a repository most plausibly uses; the user confirms them during onboarding. */
export function detectTestCommands(
  pkg: PackageJson | null,
  python: PinnedRequirement[],
  paths: string[],
): string[] {
  const commands: string[] = [];
  if (pkg) {
    const test = pkg.scripts.test;
    if (test && !/no test specified/.test(test)) commands.push("npm test");
    if (pkg.dependencies.some((d) => d.name === "@playwright/test"))
      commands.push("npx playwright test");
  }
  const hasPytest =
    python.some((r) => r.name === "pytest") ||
    paths.some(
      (p) => /(^|\/)(conftest\.py|pytest\.ini)$/.test(p) || /(^|\/)tests?\/test_[^/]+\.py$/.test(p),
    );
  if (hasPytest) commands.push("pytest -q");
  return commands;
}
