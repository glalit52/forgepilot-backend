/** Deterministic generators: live agent logs (with secret redaction), diffs, worker logs, GitHub repo lists. */
import type { TenantState } from "../tenancy/state";
import type {
  DiffFile,
  DiffLine,
  GithubRepoCandidate,
  LogLine,
  Repository,
  Session,
  Task,
  TestRun,
} from "../contract/schemas";
import { toIso } from "./support";

export const LOG_INTERVAL_MS = 1200;

type Raw = [LogLine["level"], string];

/** DP-005: secrets are redacted before display. */
const SECRET = /(sk-[A-Za-z0-9]{6,}|ghp_[A-Za-z0-9]{6,}|AKIA[0-9A-Z]{8,})/g;
function redact(text: string) {
  let n = 0;
  const out = text.replace(SECRET, () => {
    n++;
    return "[REDACTED]";
  });
  return [out, n] as const;
}

export function generateLog(db: TenantState, session: Session, now: number) {
  const task = db.tasks.find((t) => t.id === session.taskId)!;
  const repo = db.repositories.find((r) => r.id === task.repositoryId)!;
  const agent = db.agents.find((a) => a.id === session.agentId)!;
  const py = repo.ecosystems[0] === "pypi";
  const f1 =
    session.changedFiles[0]?.path ?? (py ? "app/api/handlers.py" : "src/components/Feature.tsx");
  const f2 =
    session.changedFiles[1]?.path ??
    (py ? "tests/api/test_handlers.py" : "src/components/Feature.test.tsx");
  const cmd = repo.testCommands[0] ?? "npm test";
  const intro: Raw[] = [
    [
      "info",
      `Workspace wk_${session.id.replace(/^sess_/, "")} ready · container 2 vCPU / 4 GB · network: allowlist (${db.policies.find((p) => p.orgId === task.orgId)?.networkAllowlist.length ?? 0} hosts)`,
    ],
    ["info", `Ephemeral GitHub token scoped to ${repo.fullName} (expires in 60 min)`],
    ["info", `Checked out ${task.baseSha.slice(0, 7)} on branch ${task.branch}`],
    [
      "info",
      `${agent.name} (${agent.model}) started · attempt #${session.attempt} · budget $${task.budgetUsd.toFixed(2)} · timeout ${task.timeoutMin}m`,
    ],
    [
      "info",
      `Loaded repository context: ${repo.fileCount} files indexed, ${repo.frameworks.join(", ")}, test command \`${cmd}\``,
    ],
    ...(session.notes ? ([["warn", `Notes for this attempt: ${session.notes}`]] as Raw[]) : []),
    [
      "tool",
      `env: reading .env.example (values from vault: ANTHROPIC_KEY=sk-demo0000secret redacted)`,
    ],
  ];
  const loop: Raw[] = [
    ["tool", `read ${f1}`],
    [
      "tool",
      `search "${task.title.split(" ").slice(-2).join(" ").toLowerCase()}" in ${py ? "app/" : "src/"}`,
    ],
    ["tool", `edit ${f1} (+${12 + (session.logSeed % 20)} −${2 + (session.logSeed % 6)})`],
    [
      "tool",
      `edit ${f2} (+${30 + (session.logSeed % 25)} −0) · tests for: "${task.acceptanceCriteria[0] ?? "the goal"}"`,
    ],
    ["tool", `run ${cmd}`],
    ["success", `${py ? "pytest" : "tests"}: ${40 + (session.logSeed % 60)} passed`],
    ["info", `Checking acceptance criteria (${task.acceptanceCriteria.length})`],
  ];
  const start = Date.parse(session.startedAt);
  const ended = session.endedAt ? Date.parse(session.endedAt) : null;
  const all: Raw[] = [...intro];
  const pending = db.approvals.find((a) => a.context.sessionId === session.id);
  if (ended) {
    all.push(...loop);
    if (pending)
      all.push([
        "approval",
        `Paused: approval ${pending.status} for ${String(pending.context.path ?? pending.action)}`,
      ]);
    if (session.status === "completed") {
      all.push([
        "info",
        "Self-review complete: changes stay inside the assigned repository and branch",
      ]);
      all.push([
        "success",
        `Committed ${session.headSha?.slice(0, 7)} · ${session.changedFiles.length} files changed · handing off to ShipSafe`,
      ]);
    } else if (session.status === "failed")
      all.push(["error", session.summary ?? "Session failed"]);
    else
      all.push([
        "warn",
        "Session cancelled by user; worker terminated and workspace scheduled for cleanup",
      ]);
  } else {
    const n = Math.floor((now - start) / LOG_INTERVAL_MS) + 1;
    for (let i = intro.length; i < n; i++) all.push(loop[(i - intro.length) % loop.length]);
    if (session.status === "waiting" && pending)
      all.push(["approval", `Paused: waiting for approval — ${pending.title}`]);
  }
  let redactions = 0;
  const lines = all.slice(-400).map(([level, text], i) => {
    const [clean, n] = redact(text);
    redactions += n;
    return { seq: i, at: toIso(start + i * LOG_INTERVAL_MS), level, text: clean };
  });
  const total = (session.simulatedEndsAt ?? ended ?? now) - start;
  const progressPct = ended
    ? 100
    : session.status === "waiting"
      ? 50
      : Math.min(97, Math.round(((now - start) / Math.max(1, total)) * 100));
  return { sessionId: session.id, status: session.status, lines, progressPct, redactions };
}

function hunk(start: number, lines: [DiffLine["kind"], string][]): DiffLine[] {
  let o = start;
  let n = start;
  const out: DiffLine[] = [
    {
      kind: "hunk",
      oldNo: null,
      newNo: null,
      text: `@@ -${start},${lines.length} +${start},${lines.length} @@`,
    },
  ];
  for (const [kind, text] of lines) {
    if (kind === "context") out.push({ kind, oldNo: o++, newNo: n++, text });
    else if (kind === "del") out.push({ kind, oldNo: o++, newNo: null, text });
    else out.push({ kind: "add", oldNo: null, newNo: n++, text });
  }
  return out;
}

export function generateDiff(
  task: Pick<Task, "title" | "acceptanceCriteria">,
  repo: Repository,
  files: { path: string; additions: number; deletions: number }[],
  aiAuthored: boolean,
): DiffFile[] {
  const py = repo.ecosystems[0] === "pypi";
  return files.map((f, i) => {
    const isTest = /test|spec/.test(f.path);
    const body: [DiffLine["kind"], string][] = py
      ? isTest
        ? [
            ["context", ""],
            ["add", "def test_replayed_request_returns_original(client):"],
            [
              "add",
              '    first = client.post("/refunds", json=PAYLOAD, headers={"Idempotency-Key": "k1"})',
            ],
            [
              "add",
              '    again = client.post("/refunds", json=PAYLOAD, headers={"Idempotency-Key": "k1"})',
            ],
            ["add", "    assert again.json() == first.json()"],
          ]
        : [
            ["context", '@router.post("/refunds")'],
            ["del", "async def create_refund(body: RefundIn):"],
            [
              "add",
              'async def create_refund(body: RefundIn, key: str | None = Header(None, alias="Idempotency-Key")):',
            ],
            ["add", "    if key and (cached := await idempotency.get(key)):"],
            ["add", "        return cached"],
            ["context", "    refund = await refunds.create(body)"],
            ["add", "    await idempotency.put(key, refund, ttl=timedelta(hours=24))"],
            ["context", "    return refund"],
          ]
      : isTest
        ? [
            ["context", ""],
            ["add", `test("${task.acceptanceCriteria[0] ?? "works"}", async ({ page }) => {`],
            ["add", "  await page.goto('/transactions');"],
            ["add", "  await page.getByRole('button', { name: 'Save filter' }).click();"],
            [
              "add",
              "  await expect(page.getByRole('listitem', { name: /My filter/ })).toBeVisible();",
            ],
            ["add", "});"],
          ]
        : [
            ["context", "export function Feature({ items }: Props) {"],
            ["del", "  const [filter, setFilter] = useState('');"],
            ["add", "  const { filters, save, remove } = useSavedFilters();"],
            ["add", "  const [filter, setFilter] = useState(filters[0]?.query ?? '');"],
            ["context", "  return ("],
            ["add", "    <SavedFilterMenu filters={filters} onSave={save} onRemove={remove} />"],
            ["context", "  );"],
          ];
    return {
      path: f.path,
      status: isTest && f.deletions === 0 ? "added" : "modified",
      additions: f.additions,
      deletions: f.deletions,
      aiAuthored,
      lines: hunk(12 + i * 30, body),
    };
  });
}

export function workerLog(run: TestRun, suiteNames: string[]): LogLine[] {
  const start = Date.parse(run.startedAt);
  const raw: Raw[] = [
    ["info", `Webhook ${run.trigger} verified (HMAC) · delivery deduplicated · job enqueued`],
    [
      "info",
      `Worker ${run.environment.worker} (${run.environment.region}) · isolated container · no production secrets`,
    ],
    [
      "info",
      `Fetched ${run.headSha.slice(0, 7)} (base ${run.baseSha.slice(0, 7)}) · installing from lockfile`,
    ],
    ["info", `Test plan: ${suiteNames.join(", ") || "none"}`],
    ...(run.environment.url
      ? ([["info", `Preview environment ${run.environment.url} healthy`]] as Raw[])
      : []),
  ];
  if (run.status === "running") raw.push(["tool", "Running suites…"]);
  else if (run.status === "errored")
    raw.push(
      ["error", run.infraError ?? "Worker error"],
      ["warn", "Classified as infrastructure failure: not reported as a product defect"],
    );
  else {
    raw.push([
      "tool",
      `${run.totals.passed + run.totals.failed + run.totals.flaky} tests executed`,
    ]);
    raw.push(
      run.status === "passed"
        ? ["success", "All required checks passed · Check Run conclusion: success"]
        : ["error", `${run.totals.failed} failed · Check Run conclusion: failure`],
    );
    raw.push(["info", "Evidence uploaded: screenshots, traces, console and network logs"]);
  }
  return raw.map(([level, text], i) => ({ seq: i, at: toIso(start + i * 4000), level, text }));
}

const CANDIDATES: [string, string][] = [
  ["web-app", "TypeScript"],
  ["payments-api", "Python"],
  ["ledger-worker", "Python"],
  ["mobile-bff", "TypeScript"],
  ["design-system", "TypeScript"],
  ["data-pipelines", "Python"],
  ["marketing-site", "TypeScript"],
  ["internal-tools", "TypeScript"],
];

export function githubCandidates(
  db: TenantState,
  orgId: string,
  account: string,
  now: number,
): GithubRepoCandidate[] {
  const connected = new Set(
    db.repositories.filter((r) => r.orgId === orgId).map((r) => r.fullName),
  );
  const slug =
    account
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-|-$/g, "") || "acme";
  return CANDIDATES.map(([name, language], i) => ({
    fullName: `${slug}/${name}`,
    private: i !== 6,
    language,
    defaultBranch: "main",
    pushedAt: toIso(now - (i + 1) * 7_200_000),
    alreadyConnected: connected.has(`${slug}/${name}`),
  }));
}
