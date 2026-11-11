/**
 * Advisory and registry lookups for CodeKeeper: OSV (which aggregates the
 * GitHub Advisory Database) for known vulnerabilities, the npm registry and
 * PyPI for the latest published versions. All public, unauthenticated APIs.
 */
import type { Severity } from "../contract/schemas";
import { ConnectorError, mapLimit, requestJson, type FetchLike } from "./http";

export type Ecosystem = "npm" | "pypi";

export interface PackageRef {
  ecosystem: Ecosystem;
  name: string;
  version: string;
}

export interface Advisory extends PackageRef {
  advisoryId: string;
  title: string;
  severity: Severity;
  fixedVersion: string | null;
  source: string;
  sourceUrl: string;
}

interface OsvVuln {
  id: string;
  summary?: string;
  details?: string;
  aliases?: string[];
  severity?: { type: string; score: string }[];
  database_specific?: { severity?: string };
  affected?: {
    package?: { name?: string; ecosystem?: string };
    ranges?: { type: string; events: { introduced?: string; fixed?: string }[] }[];
    database_specific?: { severity?: string };
  }[];
}

const OSV_ECOSYSTEM: Record<Ecosystem, string> = { npm: "npm", pypi: "PyPI" };
const OSV_BATCH = 500;
const MAX_ADVISORY_DETAILS = 200;

/** Severity as published by the advisory database; never guessed upward. */
export function osvSeverity(v: OsvVuln): Severity {
  const label = (
    v.database_specific?.severity ??
    v.affected?.[0]?.database_specific?.severity ??
    ""
  ).toUpperCase();
  if (label === "CRITICAL") return "critical";
  if (label === "HIGH") return "high";
  if (label === "MODERATE" || label === "MEDIUM") return "medium";
  if (label === "LOW") return "low";
  return "medium";
}

/** Numeric-aware comparison good enough to order release versions (1.10.0 > 1.9.3). */
export function compareVersions(a: string, b: string): number {
  const split = (v: string) => v.replace(/^[^0-9]*/, "").split(/[.+-]/);
  const x = split(a);
  const y = split(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const p = x[i] ?? "0";
    const q = y[i] ?? "0";
    const n = Number(p);
    const m = Number(q);
    if (Number.isFinite(n) && Number.isFinite(m)) {
      if (n !== m) return n < m ? -1 : 1;
    } else if (p !== q) return p < q ? -1 : 1;
  }
  return 0;
}

function fixedVersionFor(v: OsvVuln, pkg: PackageRef): string | null {
  const fixes: string[] = [];
  for (const a of v.affected ?? []) {
    if (a.package?.name?.toLowerCase() !== pkg.name.toLowerCase()) continue;
    if (a.package?.ecosystem !== OSV_ECOSYSTEM[pkg.ecosystem]) continue;
    for (const r of a.ranges ?? [])
      if (r.type !== "GIT") for (const e of r.events) if (e.fixed) fixes.push(e.fixed);
  }
  // The smallest fix that is newer than what is installed is the least disruptive upgrade.
  const newer = fixes.filter((f) => compareVersions(f, pkg.version) > 0).sort(compareVersions);
  return newer[0] ?? null;
}

export class AdvisoryClient {
  constructor(
    private fetchImpl: FetchLike,
    private urls = {
      osv: "https://api.osv.dev",
      npm: "https://registry.npmjs.org",
      pypi: "https://pypi.org",
    },
  ) {}

  /** Known vulnerabilities affecting exactly these package versions. */
  async vulnerabilities(packages: PackageRef[]): Promise<Advisory[]> {
    const hits: { pkg: PackageRef; id: string }[] = [];
    for (let i = 0; i < packages.length; i += OSV_BATCH) {
      const chunk = packages.slice(i, i + OSV_BATCH);
      const res = await requestJson<{ results: { vulns?: { id: string }[] }[] }>(
        this.fetchImpl,
        "osv",
        `${this.urls.osv}/v1/querybatch`,
        {
          method: "POST",
          retries: 2,
          timeoutMs: 30_000,
          body: {
            queries: chunk.map((p) => ({
              package: { name: p.name, ecosystem: OSV_ECOSYSTEM[p.ecosystem] },
              version: p.version,
            })),
          },
        },
      );
      res.results.forEach((r, j) =>
        r.vulns?.forEach((v) => hits.push({ pkg: chunk[j], id: v.id })),
      );
    }
    const ids = [...new Set(hits.map((h) => h.id))].slice(0, MAX_ADVISORY_DETAILS);
    const details = new Map<string, OsvVuln>();
    await mapLimit(ids, 6, async (id) => {
      details.set(
        id,
        await requestJson<OsvVuln>(
          this.fetchImpl,
          "osv",
          `${this.urls.osv}/v1/vulns/${encodeURIComponent(id)}`,
        ),
      );
    });
    const out: Advisory[] = [];
    for (const h of hits) {
      const v = details.get(h.id);
      if (!v) continue;
      // Prefer the GHSA/CVE alias people search for; fall back to the OSV id.
      const display = v.id.startsWith("GHSA-")
        ? v.id
        : (v.aliases?.find((a) => a.startsWith("CVE-")) ?? v.id);
      out.push({
        ...h.pkg,
        advisoryId: display,
        title: (v.summary || v.details?.split("\n")[0] || `Vulnerability in ${h.pkg.name}`).slice(
          0,
          200,
        ),
        severity: osvSeverity(v),
        fixedVersion: fixedVersionFor(v, h.pkg),
        source: v.id.startsWith("GHSA-") ? "GitHub Advisory Database (via OSV)" : "OSV",
        sourceUrl: `https://osv.dev/vulnerability/${v.id}`,
      });
    }
    return out;
  }

  /** Latest published version and license, or null when the registry does not know the package. */
  async latest(
    ecosystem: Ecosystem,
    name: string,
  ): Promise<{ version: string; license: string } | null> {
    try {
      if (ecosystem === "npm") {
        const res = await requestJson<{ version: string; license?: string | { type?: string } }>(
          this.fetchImpl,
          "npm",
          `${this.urls.npm}/${name.replace("/", "%2F")}/latest`,
        );
        const license =
          typeof res.license === "string" ? res.license : (res.license?.type ?? "Unknown");
        return { version: res.version, license };
      }
      const res = await requestJson<{ info: { version: string; license?: string | null } }>(
        this.fetchImpl,
        "pypi",
        `${this.urls.pypi}/pypi/${encodeURIComponent(name)}/json`,
      );
      return { version: res.info.version, license: (res.info.license || "Unknown").slice(0, 60) };
    } catch (err) {
      if (err instanceof ConnectorError && err.status === 404) return null;
      throw err;
    }
  }
}
