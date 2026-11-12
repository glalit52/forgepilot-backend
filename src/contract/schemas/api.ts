/**
 * Request/response shapes for the mock API (and, later, the real one).
 * Built from the entity schemas so types never drift.
 */
import { z } from "zod";
import {
  AgentSchema,
  ApiKeySchema,
  ApprovalSchema,
  AuditLogSchema,
  BugSchema,
  DependencySchema,
  FindingSchema,
  GithubIssueSchema,
  VisualSnapshotSchema,
  HealthSnapshotSchema,
  IntegrationSchema,
  InvitationSchema,
  InvoiceSchema,
  OrganizationSchema,
  PolicySchema,
  ProjectSchema,
  PullRequestSchema,
  RepositorySchema,
  ScanSchema,
  SessionSchema,
  TaskSchema,
  TestResultSchema,
  TestRunSchema,
  TestSuiteSchema,
  UserSchema,
  WorkspaceSchema,
} from "./entities";
import {
  FailureClassSchema,
  MeterSchema,
  PlanIdSchema,
  PrioritySchema,
  ProviderSchema,
  RoleSchema,
  TaskStatusSchema,
  WorkspaceKindSchema,
} from "./enums";

export const ResolvedActorSchema = z.object({
  type: z.enum(["person", "agent", "system"]),
  id: z.string(),
  name: z.string(),
  /** Title for people, model for agents, subsystem for system actors. */
  detail: z.string(),
});
export type ResolvedActor = z.infer<typeof ResolvedActorSchema>;

export const ActivityItemSchema = AuditLogSchema.extend({
  actorResolved: ResolvedActorSchema,
  label: z.string(),
  href: z.string().nullable(),
});
export type ActivityItem = z.infer<typeof ActivityItemSchema>;

// ---------------------------------------------------------------- session & workspace
export const WorkspaceMembershipSchema = z.object({
  organization: OrganizationSchema,
  role: RoleSchema,
});
export type WorkspaceMembership = z.infer<typeof WorkspaceMembershipSchema>;

export const SessionInfoSchema = z.object({
  user: UserSchema,
  workspace: OrganizationSchema,
  role: RoleSchema,
  workspaces: z.array(WorkspaceMembershipSchema),
  personas: z.array(
    UserSchema.extend({
      workspaces: z.array(z.object({ orgId: z.string(), name: z.string(), role: RoleSchema })),
    }),
  ),
  counts: z.object({
    pendingApprovals: z.number(),
    reviewReady: z.number(),
    unreadNotifications: z.number(),
    pendingVisuals: z.number(),
  }),
});
export type SessionInfo = z.infer<typeof SessionInfoSchema>;

export const SignInInputSchema = z.object({ userId: z.string(), orgId: z.string().optional() });
export const SwitchWorkspaceInputSchema = z.object({ orgId: z.string() });

export const SignUpInputSchema = z.object({
  name: z.string().trim().min(2, "Enter your name"),
  email: z.email("Enter a valid work email"),
  method: z.enum(["github", "email"]),
  /** Required by the real backend for email sign-up; the demo has no passwords. */
  password: z.string().min(10, "Use at least 10 characters").max(200).optional(),
  /** Joins the inviting workspace right after the account is created. */
  invitationToken: z.string().optional(),
});
export type SignUpInput = z.infer<typeof SignUpInputSchema>;

/** Which sign-in methods the API offers: the demo uses personas, a real deployment passwords and GitHub. */
export const AuthOptionsSchema = z.object({
  demo: z.boolean(),
  password: z.boolean(),
  github: z.boolean(),
  githubSignInUrl: z.string().nullable(),
  githubAppInstallUrl: z.string().nullable(),
  /** Where "Sign in with SSO" sends the browser (real backend only). */
  ssoSignInUrl: z.string().nullable().optional(),
});
export type AuthOptions = z.infer<typeof AuthOptionsSchema>;

export const LoginInputSchema = z.object({
  email: z.email("Enter a valid email"),
  password: z.string().min(1, "Enter your password").max(200),
});
export const AuthResultSchema = z.object({
  user: UserSchema,
  hasWorkspace: z.boolean(),
  /** The account has two-factor sign-in on: a 6-digit code is needed before anything else works. */
  twoFactorRequired: z.boolean().optional(),
});

export const CreateWorkspaceInputSchema = z.object({
  name: z.string().trim().min(2, "Name your workspace").max(48),
  kind: WorkspaceKindSchema,
  useCase: z.enum([
    "ship_ai_code_safely",
    "verify_prs",
    "maintain_repos",
    "coordinate_agents",
    "agency_client_repos",
    "personal_projects",
  ]),
});
export type CreateWorkspaceInput = z.infer<typeof CreateWorkspaceInputSchema>;

// ---------------------------------------------------------------- summaries
export const RepositorySummarySchema = RepositorySchema.extend({
  projectName: z.string(),
  openFindings: z.number(),
  criticalFindings: z.number(),
  suites: z.number(),
  lastRunStatus: z.string().nullable(),
  lastRunAt: z.string().nullable(),
  openPrs: z.number(),
  healthDelta: z.number(),
  scanRunning: z.boolean(),
});
export type RepositorySummary = z.infer<typeof RepositorySummarySchema>;

export const ProjectSummarySchema = ProjectSchema.extend({
  repositories: z.number(),
  healthScore: z.number().nullable(),
  openPrs: z.number(),
  failingChecks: z.number(),
  activeSessions: z.number(),
  openFindings: z.number(),
  verifiedThisMonth: z.number(),
});
export type ProjectSummary = z.infer<typeof ProjectSummarySchema>;

export const TaskListItemSchema = TaskSchema.extend({
  repositoryName: z.string(),
  projectName: z.string(),
  agent: AgentSchema.nullable(),
  createdByUser: UserSchema.nullable(),
  latestSession: SessionSchema.nullable(),
  attempts: z.number(),
  pullRequest: PullRequestSchema.nullable(),
  latestRunStatus: z.string().nullable(),
  costUsd: z.number(),
  verified: z.boolean(),
});
export type TaskListItem = z.infer<typeof TaskListItemSchema>;

export const PullRequestListItemSchema = PullRequestSchema.extend({
  repositoryName: z.string(),
  authorResolved: ResolvedActorSchema,
  taskTitle: z.string().nullable(),
  latestRun: TestRunSchema.nullable(),
  openBugs: z.number(),
  requiredChecksMet: z.boolean(),
});
export type PullRequestListItem = z.infer<typeof PullRequestListItemSchema>;

export const TestRunListItemSchema = TestRunSchema.extend({
  repositoryName: z.string(),
  pullRequestNumber: z.number().nullable(),
  pullRequestTitle: z.string().nullable(),
  failureClasses: z.record(z.string(), z.number()),
});
export type TestRunListItem = z.infer<typeof TestRunListItemSchema>;

export const BugListItemSchema = BugSchema.extend({
  repositoryName: z.string(),
  pullRequestNumber: z.number().nullable(),
  testName: z.string(),
  taskStatus: TaskStatusSchema.nullable(),
});
export type BugListItem = z.infer<typeof BugListItemSchema>;

export const FindingListItemSchema = FindingSchema.extend({
  repositoryName: z.string(),
  projectName: z.string(),
  taskStatus: TaskStatusSchema.nullable(),
});
export type FindingListItem = z.infer<typeof FindingListItemSchema>;

export const SessionListItemSchema = SessionSchema.extend({
  taskTitle: z.string(),
  repositoryName: z.string(),
  agent: AgentSchema,
  durationSec: z.number().nullable(),
  workspaceState: z.string().nullable(),
});
export type SessionListItem = z.infer<typeof SessionListItemSchema>;

// ---------------------------------------------------------------- details
export const LifecycleStepSchema = z.object({
  key: z.enum(["plan", "execute", "propose", "verify", "remediate", "review", "merge", "maintain"]),
  label: z.string(),
  state: z.enum(["done", "current", "upcoming", "failed", "skipped"]),
  detail: z.string().nullable(),
  href: z.string().nullable(),
});
export type LifecycleStep = z.infer<typeof LifecycleStepSchema>;

export const TaskDetailSchema = z.object({
  task: TaskListItemSchema,
  sessions: z.array(SessionSchema.extend({ workspace: WorkspaceSchema.nullable() })),
  approvals: z.array(ApprovalSchema),
  pullRequest: PullRequestListItemSchema.nullable(),
  runs: z.array(TestRunListItemSchema),
  bug: BugSchema.nullable(),
  finding: FindingSchema.nullable(),
  parent: TaskSchema.nullable(),
  children: z.array(TaskSchema),
  lifecycle: z.array(LifecycleStepSchema),
  activity: z.array(ActivityItemSchema),
  policyPreview: z.object({
    allowed: z.array(z.string()),
    requiresApproval: z.array(z.string()),
    prohibited: z.array(z.string()),
    budgetRemainingUsd: z.number(),
  }),
});
export type TaskDetail = z.infer<typeof TaskDetailSchema>;

export const SessionDetailSchema = z.object({
  session: SessionListItemSchema,
  task: TaskSchema,
  workspace: WorkspaceSchema.nullable(),
  approvals: z.array(ApprovalSchema),
  otherAttempts: z.array(SessionSchema),
});
export type SessionDetail = z.infer<typeof SessionDetailSchema>;

export const LogLineSchema = z.object({
  seq: z.number().int(),
  at: z.string(),
  level: z.enum(["info", "tool", "warn", "error", "success", "approval"]),
  text: z.string(),
});
export type LogLine = z.infer<typeof LogLineSchema>;

export const LiveLogSchema = z.object({
  sessionId: z.string(),
  status: z.string(),
  lines: z.array(LogLineSchema),
  progressPct: z.number(),
  redactions: z.number(),
});
export type LiveLog = z.infer<typeof LiveLogSchema>;

export const DiffLineSchema = z.object({
  kind: z.enum(["context", "add", "del", "hunk"]),
  oldNo: z.number().nullable(),
  newNo: z.number().nullable(),
  text: z.string(),
});
export const DiffFileSchema = z.object({
  path: z.string(),
  status: z.enum(["modified", "added", "deleted"]),
  additions: z.number().int(),
  deletions: z.number().int(),
  aiAuthored: z.boolean(),
  lines: z.array(DiffLineSchema),
});
export type DiffFile = z.infer<typeof DiffFileSchema>;
export type DiffLine = z.infer<typeof DiffLineSchema>;

export const PolicyCheckSchema = z.object({
  name: z.string(),
  required: z.boolean(),
  status: z.enum(["passed", "failed", "pending", "missing"]),
  detail: z.string(),
});
export type PolicyCheck = z.infer<typeof PolicyCheckSchema>;

export const PullRequestDetailSchema = z.object({
  pullRequest: PullRequestListItemSchema,
  repository: RepositorySchema,
  task: TaskSchema.nullable(),
  session: SessionSchema.nullable(),
  runs: z.array(TestRunListItemSchema),
  latestResults: z.array(TestResultSchema.extend({ suiteName: z.string() })),
  bugs: z.array(BugSchema),
  releasePolicy: z.array(PolicyCheckSchema),
  mergeable: z.boolean(),
  mergeBlockers: z.array(z.string()),
});
export type PullRequestDetail = z.infer<typeof PullRequestDetailSchema>;

export const TestRunDetailSchema = z.object({
  run: TestRunListItemSchema,
  repository: RepositorySchema,
  pullRequest: PullRequestSchema.nullable(),
  suites: z.array(
    TestSuiteSchema.extend({
      reason: z.string(),
      passed: z.number(),
      failed: z.number(),
      flaky: z.number(),
    }),
  ),
  results: z.array(TestResultSchema.extend({ suiteName: z.string() })),
  previous: TestRunSchema.nullable(),
  comparison: z
    .object({
      newlyFailing: z.array(z.string()),
      fixed: z.array(z.string()),
      stillFailing: z.array(z.string()),
    })
    .nullable(),
  bugs: z.array(BugSchema),
  workerLog: z.array(LogLineSchema),
});
export type TestRunDetail = z.infer<typeof TestRunDetailSchema>;

export const BugDetailSchema = z.object({
  bug: BugListItemSchema,
  result: TestResultSchema,
  run: TestRunSchema,
  pullRequest: PullRequestSchema.nullable(),
  task: TaskSchema.nullable(),
  repository: RepositorySchema,
});
export type BugDetail = z.infer<typeof BugDetailSchema>;

export const RepositoryDetailSchema = z.object({
  repository: RepositorySummarySchema,
  suites: z.array(TestSuiteSchema),
  findings: z.array(FindingSchema),
  dependencies: z.number(),
  history: z.array(HealthSnapshotSchema),
  scans: z.array(ScanSchema),
  runs: z.array(TestRunListItemSchema),
  pullRequests: z.array(PullRequestListItemSchema),
});
export type RepositoryDetail = z.infer<typeof RepositoryDetailSchema>;

export const ProjectDetailSchema = z.object({
  project: ProjectSummarySchema,
  repositories: z.array(RepositorySummarySchema),
  tasks: z.array(TaskListItemSchema),
  pullRequests: z.array(PullRequestListItemSchema),
  runs: z.array(TestRunListItemSchema),
  findings: z.array(FindingListItemSchema),
});
export type ProjectDetail = z.infer<typeof ProjectDetailSchema>;

export const FindingDetailSchema = z.object({
  finding: FindingListItemSchema,
  dependency: DependencySchema.nullable(),
  repository: RepositorySchema,
  task: TaskListItemSchema.nullable(),
  similar: z.array(FindingListItemSchema),
});
export type FindingDetail = z.infer<typeof FindingDetailSchema>;

// ---------------------------------------------------------------- dashboards
export const TrendPointSchema = z.object({ date: z.string(), value: z.number() });
export type TrendPoint = z.infer<typeof TrendPointSchema>;

export const AttentionItemSchema = z.object({
  id: z.string(),
  kind: z.enum([
    "approval",
    "failed_check",
    "critical_finding",
    "budget",
    "integration",
    "review_ready",
    "waiting_input",
  ]),
  title: z.string(),
  detail: z.string(),
  href: z.string(),
  severity: z.enum(["danger", "warning", "info"]),
});
export type AttentionItem = z.infer<typeof AttentionItemSchema>;

export const OverviewSchema = z.object({
  northStar: z.object({
    value: z.number(),
    previous: z.number(),
    weekly: z.array(TrendPointSchema),
  }),
  kpis: z.object({
    activeSessions: z.number(),
    prsAwaitingReview: z.number(),
    verificationCoveragePct: z.number(),
    openBugs: z.number(),
    avgHealth: z.number().nullable(),
    passRatePct: z.number(),
    spendUsd: z.number(),
    budgetUsd: z.number(),
  }),
  lifecycle: z.array(
    z.object({ key: z.string(), label: z.string(), count: z.number(), href: z.string() }),
  ),
  attention: z.array(AttentionItemSchema),
  activity: z.array(ActivityItemSchema),
  liveSessions: z.array(SessionListItemSchema),
  modules: z.object({
    devpilot: z.object({
      running: z.number(),
      reviewReady: z.number(),
      successRatePct: z.number(),
    }),
    shipsafe: z.object({ runsToday: z.number(), passRatePct: z.number(), openBugs: z.number() }),
    codekeeper: z.object({
      avgHealth: z.number().nullable(),
      openFindings: z.number(),
      critical: z.number(),
    }),
  }),
  setup: z.array(
    z.object({ key: z.string(), label: z.string(), done: z.boolean(), href: z.string() }),
  ),
});
export type Overview = z.infer<typeof OverviewSchema>;

export const ShipSafeOverviewSchema = z.object({
  passRateTrend: z.array(z.object({ date: z.string(), passRatePct: z.number(), runs: z.number() })),
  kpis: z.object({
    runs7d: z.number(),
    passRatePct: z.number(),
    medianDurationSec: z.number(),
    flakyRatePct: z.number(),
    openBugs: z.number(),
    verificationCoveragePct: z.number(),
    actionableDefectPct: z.number(),
  }),
  failureBreakdown: z.array(z.object({ classification: FailureClassSchema, count: z.number() })),
  repositories: z.array(
    z.object({
      repositoryId: z.string(),
      name: z.string(),
      passRatePct: z.number(),
      runs: z.number(),
      lastStatus: z.string().nullable(),
    }),
  ),
  recentRuns: z.array(TestRunListItemSchema),
  openBugs: z.array(BugListItemSchema),
});
export type ShipSafeOverview = z.infer<typeof ShipSafeOverviewSchema>;

export const CodeKeeperOverviewSchema = z.object({
  avgHealth: z.number().nullable(),
  healthTrend: z.array(TrendPointSchema),
  repositories: z.array(RepositorySummarySchema),
  findingsBySeverity: z.record(z.string(), z.number()),
  findingsByCategory: z.record(z.string(), z.number()),
  recentScans: z.array(ScanSchema.extend({ repositoryName: z.string() })),
  maintenance: z.object({
    prsCreated: z.number(),
    prsMerged: z.number(),
    acceptancePct: z.number(),
    inProgress: z.number(),
  }),
  queue: z.array(FindingListItemSchema),
});
export type CodeKeeperOverview = z.infer<typeof CodeKeeperOverviewSchema>;

export const DevPilotOverviewSchema = z.object({
  kpis: z.object({
    running: z.number(),
    waiting: z.number(),
    reviewReady: z.number(),
    successRatePct: z.number(),
    avgCostUsd: z.number(),
    spend30dUsd: z.number(),
  }),
  board: z.record(z.string(), z.array(TaskListItemSchema)),
  liveSessions: z.array(SessionListItemSchema),
  agents: z.array(
    AgentSchema.extend({
      running: z.number(),
      sessions30d: z.number(),
      successRatePct: z.number(),
      costUsd30d: z.number(),
    }),
  ),
});
export type DevPilotOverview = z.infer<typeof DevPilotOverviewSchema>;

export const AnalyticsSchema = z.object({
  rangeDays: z.number(),
  northStar: z.array(TrendPointSchema),
  taskSuccessByType: z.array(
    z.object({
      category: z.string(),
      tasks: z.number(),
      successPct: z.number(),
      avgCostUsd: z.number(),
      reworkPct: z.number(),
    }),
  ),
  providers: z.array(
    z.object({
      provider: ProviderSchema,
      sessions: z.number(),
      successPct: z.number(),
      avgMinutes: z.number(),
      costUsd: z.number(),
      humanInterventions: z.number(),
    }),
  ),
  prAcceptance: z.object({
    agentPct: z.number(),
    humanPct: z.number(),
    agentMerged: z.number(),
    humanMerged: z.number(),
  }),
  testUsefulness: z.object({
    actionablePct: z.number(),
    reported: z.number(),
    falsePositive: z.number(),
  }),
  timeToVerifyMinP50: z.number(),
  costPerVerifiedTaskUsd: z.number(),
  spendByDay: z.array(z.object({ date: z.string(), agentUsd: z.number(), browserUsd: z.number() })),
});
export type Analytics = z.infer<typeof AnalyticsSchema>;

// ---------------------------------------------------------------- billing
export const MeterUsageSchema = z.object({
  meter: MeterSchema,
  label: z.string(),
  unit: z.string(),
  used: z.number(),
  included: z.number().nullable(),
  projected: z.number(),
  overageUnits: z.number(),
  overageUsd: z.number(),
  unitPriceUsd: z.number(),
});
export type MeterUsage = z.infer<typeof MeterUsageSchema>;

export const BillingSchema = z.object({
  plan: PlanIdSchema,
  billingCycle: z.enum(["monthly", "annual"]),
  seatsUsed: z.number(),
  seatsIncluded: z.number().nullable(),
  periodStart: z.string(),
  periodEnd: z.string(),
  subscriptionUsd: z.number(),
  usage: z.array(MeterUsageSchema),
  spend: z.object({
    usageCostUsd: z.number(),
    projectedUsd: z.number(),
    budgetUsd: z.number(),
    hardCap: z.boolean(),
    alertAtPct: z.array(z.number()),
    pctOfBudget: z.number(),
  }),
  dailyCost: z.array(z.object({ date: z.string(), costUsd: z.number() })),
  costByProject: z.array(
    z.object({ projectId: z.string(), name: z.string(), costUsd: z.number() }),
  ),
  costByProvider: z.array(z.object({ provider: z.string(), costUsd: z.number() })),
  invoices: z.array(InvoiceSchema),
  paymentMethod: z.object({ brand: z.string(), last4: z.string(), expires: z.string() }).nullable(),
  limits: z.array(
    z.object({
      key: z.string(),
      label: z.string(),
      used: z.number(),
      limit: z.number().nullable(),
    }),
  ),
});
export type Billing = z.infer<typeof BillingSchema>;

export const ChangePlanInputSchema = z.object({
  plan: PlanIdSchema,
  billingCycle: z.enum(["monthly", "annual"]),
});
export const BudgetInputSchema = z.object({
  monthlyLimitUsd: z.number({ error: "Enter an amount" }).min(0).max(1_000_000),
  hardCap: z.boolean(),
  alertAtPct: z.array(z.number().min(1).max(100)).max(5),
});
export type BudgetInput = z.infer<typeof BudgetInputSchema>;

// ---------------------------------------------------------------- inputs
export const NewTaskInputSchema = z.object({
  repositoryId: z.string().min(1, "Choose a repository"),
  title: z.string().trim().min(5, "Give the task a clear title (5+ characters)").max(140),
  description: z.string().trim().min(15, "Describe the goal in at least 15 characters"),
  acceptanceCriteria: z
    .array(z.string().trim().min(3))
    .min(1, "Add at least one acceptance criterion"),
  constraints: z.array(z.string().trim().min(3)).default([]),
  priority: PrioritySchema,
  agentId: z.string().min(1, "Choose an agent"),
  targetBranch: z.string().min(1),
  budgetUsd: z.number().min(0.5, "Budget must be at least $0.50").max(200),
  timeoutMin: z.number().min(5).max(240),
  launch: z.boolean(),
  source: z
    .enum(["manual", "github_issue", "linear", "jira", "shipsafe_failure", "codekeeper_finding"])
    .default("manual"),
  sourceRef: z.string().nullable().default(null),
  bugId: z.string().nullable().default(null),
  findingId: z.string().nullable().default(null),
  parentTaskId: z.string().nullable().default(null),
});
export type NewTaskInput = z.input<typeof NewTaskInputSchema>;

export const TaskActionSchema = z.enum([
  "launch",
  "cancel",
  "retry",
  "create_pr",
  "mark_ready",
  "archive",
]);
export type TaskAction = z.infer<typeof TaskActionSchema>;
export const TaskActionInputSchema = z.object({
  action: TaskActionSchema,
  notes: z.string().optional(),
  simulateFailure: z.boolean().optional(),
});
export type TaskActionInput = z.infer<typeof TaskActionInputSchema>;

export const ApprovalDecisionInputSchema = z
  .object({ decision: z.enum(["approved", "rejected"]), comment: z.string().trim().default("") })
  .refine((v) => v.decision === "approved" || v.comment.length >= 3, {
    message: "Say why (at least 3 characters)",
    path: ["comment"],
  });
export type ApprovalDecisionInput = z.input<typeof ApprovalDecisionInputSchema>;

export const SessionInputSchema = z.object({ answer: z.string().trim().min(2, "Type an answer") });

export const FindingActionInputSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("create_task"), agentId: z.string().optional() }),
  z.object({
    action: z.literal("suppress"),
    reason: z.string().trim().min(5, "Explain why (5+ characters)"),
    expiresInDays: z.number().int().min(1).max(365),
  }),
  z.object({ action: z.literal("unsuppress") }),
]);
export type FindingActionInput = z.infer<typeof FindingActionInputSchema>;

export const BugActionInputSchema = z.object({
  action: z.enum(["create_fix_task", "resolve", "wont_fix", "reopen"]),
  agentId: z.string().optional(),
  comment: z.string().optional(),
});
export type BugActionInput = z.infer<typeof BugActionInputSchema>;

export const ReviewInputSchema = z.object({
  decision: z.enum(["approved", "changes_requested"]),
  comment: z.string().default(""),
});

export const NewTestRunInputSchema = z.object({
  repositoryId: z.string().min(1),
  branch: z.string().min(1).default("main"),
  simulateFailure: z.boolean().optional(),
});

export const TestSuiteInputSchema = z.object({
  repositoryId: z.string().min(1, "Choose a repository"),
  name: z.string().trim().min(2, "Name the suite"),
  type: z.enum(["unit", "playwright", "api"]),
  command: z.string().trim().min(2, "Enter the command that runs the tests"),
  environment: z.string().min(1),
  pathRules: z.array(z.string().min(1)).min(1, "Add at least one path rule"),
  timeoutMin: z.number().int().min(1).max(120),
  required: z.boolean(),
});
export type TestSuiteInput = z.infer<typeof TestSuiteInputSchema>;
export const TestSuitePatchSchema = z.object({
  enabled: z.boolean().optional(),
  required: z.boolean().optional(),
  command: z.string().min(2).optional(),
  timeoutMin: z.number().int().min(1).max(120).optional(),
});

export const NewProjectInputSchema = z.object({
  name: z.string().trim().min(2, "Name the project"),
  description: z.string().trim().default(""),
});

export const InviteInputSchema = z.object({
  email: z.email("Enter a valid email"),
  role: RoleSchema.exclude(["owner"]),
});
export type InviteInput = z.infer<typeof InviteInputSchema>;
export const RoleChangeInputSchema = z.object({ role: RoleSchema });

export const PolicyPatchSchema = PolicySchema.omit({ orgId: true }).partial();
export type PolicyPatch = z.infer<typeof PolicyPatchSchema>;

export const ApiKeyInputSchema = z.object({
  name: z.string().trim().min(2, "Name the key"),
  scopes: z.array(z.string()).min(1, "Choose at least one scope"),
});
export const ApiKeyCreatedSchema = z.object({ key: ApiKeySchema, secret: z.string() });

export const ConnectIntegrationInputSchema = z.object({
  account: z.string().trim().min(2, "Enter the account or workspace"),
  /** GitHub App installation id that GitHub sends back after installing (real backend only). */
  installationId: z.coerce.number().int().positive().optional(),
  /** Provider secret (API key, webhook URL…). Sent once, stored encrypted, never returned. */
  credentials: z.record(z.string(), z.string().min(1).max(4000)).optional(),
});

export const WorkspacePatchSchema = z.object({ name: z.string().trim().min(2).max(48).optional() });

// ---------------------------------------------------------------- integrations, members, misc
export const IntegrationCategorySchema = z.enum([
  "source_control",
  "agents",
  "issues",
  "notifications",
  "observability",
  "security",
  "identity",
]);
export type IntegrationCategory = z.infer<typeof IntegrationCategorySchema>;

export const IntegrationViewSchema = z.object({
  providerId: z.string(),
  name: z.string(),
  category: IntegrationCategorySchema,
  description: z.string(),
  availability: z.enum(["available", "beta", "coming_soon", "enterprise"]),
  scopes: z.array(z.string()),
  monogram: z.string(),
  connection: IntegrationSchema.nullable(),
});
export type IntegrationView = z.infer<typeof IntegrationViewSchema>;

export const MemberSchema = UserSchema.extend({
  role: RoleSchema,
  joinedAt: z.string(),
  lastActiveAt: z.string().nullable(),
});
export type Member = z.infer<typeof MemberSchema>;
export const MembersSchema = z.object({
  members: z.array(MemberSchema),
  invitations: z.array(InvitationSchema),
  seatsPurchased: z.number(),
  seatsIncluded: z.number().nullable(),
});
export type Members = z.infer<typeof MembersSchema>;

export const SearchResultSchema = z.object({
  kind: z.enum(["project", "repository", "task", "pull_request", "bug", "finding", "session"]),
  id: z.string(),
  title: z.string(),
  subtitle: z.string(),
  href: z.string(),
});
export type SearchResult = z.infer<typeof SearchResultSchema>;

export const GithubRepoCandidateSchema = z.object({
  fullName: z.string(),
  private: z.boolean(),
  language: z.string(),
  defaultBranch: z.string(),
  pushedAt: z.string(),
  alreadyConnected: z.boolean(),
});
export type GithubRepoCandidate = z.infer<typeof GithubRepoCandidateSchema>;

export const ConnectReposInputSchema = z.object({
  repositories: z.array(z.string()).min(1, "Select at least one repository"),
  projectId: z.string().nullable(),
  newProjectName: z.string().trim().nullable(),
});
export const ConnectReposResultSchema = z.object({
  projectId: z.string(),
  repositoryIds: z.array(z.string()),
});

export const RepoConfigInputSchema = z.object({
  testCommands: z.array(z.string().min(1)).min(1),
  scanSchedule: z.enum(["daily", "weekly", "on_push", "off"]),
});

export const FirstRunInputSchema = z.object({
  repositoryId: z.string(),
  kind: z.enum(["test", "scan"]),
});
export const FirstRunResultSchema = z.object({
  kind: z.enum(["test", "scan"]),
  id: z.string(),
  href: z.string(),
});

export const OkSchema = z.object({ ok: z.literal(true) });

export const PlanSchema = z.object({
  id: PlanIdSchema,
  name: z.string(),
  priceMonthlyUsd: z.number().nullable(),
  priceAnnualMonthlyUsd: z.number().nullable(),
  tagline: z.string(),
  audience: z.string(),
  highlighted: z.boolean(),
  limits: z.object({
    projects: z.number().nullable(),
    repositories: z.number().nullable(),
    seats: z.number().nullable(),
    agentMinutes: z.number().nullable(),
    browserMinutes: z.number().nullable(),
    testRuns: z.number().nullable(),
    historyDays: z.number().nullable(),
    concurrentSessions: z.number().nullable(),
  }),
  features: z.array(z.string()),
});
export type Plan = z.infer<typeof PlanSchema>;

// ---------------------------------------------------------------- visual comparison & issue import
export const VisualSnapshotListItemSchema = VisualSnapshotSchema.extend({
  repositoryName: z.string(),
  pullRequestNumber: z.number().nullable(),
  pullRequestTitle: z.string().nullable(),
  decidedByUser: UserSchema.nullable(),
  bugId: z.string().nullable(),
});
export type VisualSnapshotListItem = z.infer<typeof VisualSnapshotListItemSchema>;

export const VisualDecisionInputSchema = z
  .object({ decision: z.enum(["approved", "rejected"]), comment: z.string().trim().default("") })
  .refine((v) => v.decision === "approved" || v.comment.length >= 5, {
    message: "Describe what looks wrong (at least 5 characters)",
    path: ["comment"],
  });
export type VisualDecisionInput = z.input<typeof VisualDecisionInputSchema>;

export const GithubIssueListItemSchema = GithubIssueSchema.extend({
  repositoryName: z.string(),
  authorUser: UserSchema.nullable(),
  importedTaskStatus: TaskStatusSchema.nullable(),
  /** What the import will produce, so users can preview before importing. */
  suggestedPriority: PrioritySchema,
  suggestedCriteria: z.array(z.string()),
});
export type GithubIssueListItem = z.infer<typeof GithubIssueListItemSchema>;

export const ImportIssuesInputSchema = z.object({
  issueIds: z
    .array(z.string())
    .min(1, "Select at least one issue")
    .max(20, "Import at most 20 issues at a time"),
  agentId: z.string().min(1, "Choose an agent"),
  launch: z.boolean(),
});
export type ImportIssuesInput = z.infer<typeof ImportIssuesInputSchema>;
export const ImportIssuesResultSchema = z.object({
  tasks: z.array(TaskSchema),
  skipped: z.array(z.string()),
});
