import { z } from "zod";
import {
  ApprovalActionSchema,
  ApprovalStatusSchema,
  FailureClassSchema,
  FindingCategorySchema,
  FindingStatusSchema,
  MeterSchema,
  PlanIdSchema,
  PrioritySchema,
  ProviderSchema,
  RoleSchema,
  SessionStatusSchema,
  SeveritySchema,
  TaskSourceSchema,
  TaskStatusSchema,
  TestOutcomeSchema,
  TestRunStatusSchema,
  WorkspaceKindSchema,
} from "./enums";

const dt = z.iso.datetime();
const sha = z.string().regex(/^[0-9a-f]{7,40}$/, "commit SHA");

export const ActorRefSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("person"), id: z.string() }),
  z.object({ type: z.literal("agent"), id: z.string() }),
  z.object({ type: z.literal("system"), id: z.string() }),
]);
export type ActorRef = z.infer<typeof ActorRefSchema>;

export const UserSchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.email(),
  title: z.string().default(""),
  githubLogin: z.string().optional(),
});
export type User = z.infer<typeof UserSchema>;

export const OrganizationSchema = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  kind: WorkspaceKindSchema,
  plan: PlanIdSchema,
  billingCycle: z.enum(["monthly", "annual"]),
  createdAt: dt,
  useCase: z.string(),
  seatsPurchased: z.number().int().positive(),
  budget: z.object({
    monthlyLimitUsd: z.number().nonnegative(),
    hardCap: z.boolean(),
    alertAtPct: z.array(z.number()),
  }),
  trialEndsAt: dt.nullable(),
});
export type Organization = z.infer<typeof OrganizationSchema>;

export const MembershipSchema = z.object({
  orgId: z.string(),
  userId: z.string(),
  role: RoleSchema,
  joinedAt: dt,
});
export type Membership = z.infer<typeof MembershipSchema>;

export const InvitationSchema = z.object({
  id: z.string(),
  orgId: z.string(),
  email: z.email(),
  role: RoleSchema,
  invitedBy: z.string(),
  sentAt: dt,
  status: z.enum(["pending", "accepted", "revoked"]),
});
export type Invitation = z.infer<typeof InvitationSchema>;

export const ProjectSchema = z.object({
  id: z.string(),
  orgId: z.string(),
  name: z.string(),
  description: z.string(),
  color: z.string(),
  createdAt: dt,
  client: z.string().optional(),
});
export type Project = z.infer<typeof ProjectSchema>;

export const HealthSchema = z.object({
  score: z.number().min(0).max(100),
  scoreVersion: z.string(),
  dependencies: z.number().min(0).max(100).nullable(),
  security: z.number().min(0).max(100).nullable(),
  buildStability: z.number().min(0).max(100).nullable(),
  tests: z.number().min(0).max(100).nullable(),
  /** null = unknown (never silently treated as healthy, PRD §8.5). */
  docs: z.number().min(0).max(100).nullable(),
});
export type Health = z.infer<typeof HealthSchema>;

export const RepositorySchema = z.object({
  id: z.string(),
  projectId: z.string(),
  orgId: z.string(),
  provider: z.literal("github"),
  fullName: z.string(),
  url: z.url(),
  defaultBranch: z.string(),
  private: z.boolean(),
  languages: z.array(z.string()),
  frameworks: z.array(z.string()),
  ecosystems: z.array(z.enum(["npm", "pypi"])),
  testCommands: z.array(z.string()),
  ciWorkflows: z.array(z.string()),
  indexedSha: sha,
  indexedAt: dt,
  indexStatus: z.enum(["pending", "indexing", "ready", "error"]),
  /** Mock-only: when simulated indexing finishes. */
  indexReadyAt: z.number().optional(),
  fileCount: z.number().int(),
  hasDocs: z.boolean(),
  scanSchedule: z.enum(["daily", "weekly", "on_push", "off"]),
  health: HealthSchema,
});
export type Repository = z.infer<typeof RepositorySchema>;

export const IntegrationSchema = z.object({
  id: z.string(),
  orgId: z.string(),
  providerId: z.string(),
  status: z.enum(["connected", "disconnected", "error"]),
  account: z.string(),
  connectedAt: dt.nullable(),
  scopes: z.array(z.string()),
  error: z.string().optional(),
});
export type Integration = z.infer<typeof IntegrationSchema>;

export const AgentSchema = z.object({
  id: z.string(),
  orgId: z.string(),
  provider: ProviderSchema,
  name: z.string(),
  model: z.string(),
  status: z.enum(["active", "suspended"]),
  maxConcurrent: z.number().int().positive(),
  defaultTimeoutMin: z.number().positive(),
  defaultBudgetUsd: z.number().nonnegative(),
});
export type Agent = z.infer<typeof AgentSchema>;

export const ApprovalRuleSchema = z.object({
  action: ApprovalActionSchema,
  mode: z.enum(["allow", "require_approval", "prohibited"]),
  approverRole: RoleSchema,
});
export type ApprovalRule = z.infer<typeof ApprovalRuleSchema>;

export const PolicySchema = z.object({
  orgId: z.string(),
  allowedProviders: z.array(ProviderSchema),
  requirePrApproval: z.boolean(),
  protectedPaths: z.array(z.string()),
  networkAllowlist: z.array(z.string()),
  requiredChecks: z.array(z.string()),
  maxFixRetries: z.number().int().min(0).max(10),
  sessionTimeoutMin: z.number().positive(),
  approvalRules: z.array(ApprovalRuleSchema),
  suppressionMaxDays: z.number().int().positive(),
  retentionDays: z.object({ logs: z.number(), artifacts: z.number(), audit: z.number() }),
});
export type Policy = z.infer<typeof PolicySchema>;

export const TestSuiteSchema = z.object({
  id: z.string(),
  repositoryId: z.string(),
  orgId: z.string(),
  name: z.string(),
  type: z.enum(["unit", "playwright", "api"]),
  command: z.string(),
  environment: z.string(),
  pathRules: z.array(z.string()),
  timeoutMin: z.number().positive(),
  owner: z.string(),
  enabled: z.boolean(),
  required: z.boolean(),
  flakyRatePct: z.number().min(0),
  testCount: z.number().int(),
});
export type TestSuite = z.infer<typeof TestSuiteSchema>;

export const DependencySchema = z.object({
  id: z.string(),
  repositoryId: z.string(),
  orgId: z.string(),
  ecosystem: z.enum(["npm", "pypi"]),
  name: z.string(),
  installedVersion: z.string(),
  latestVersion: z.string(),
  direct: z.boolean(),
  license: z.string(),
  manifest: z.string(),
});
export type Dependency = z.infer<typeof DependencySchema>;

export const FindingSchema = z.object({
  id: z.string(),
  repositoryId: z.string(),
  orgId: z.string(),
  category: FindingCategorySchema,
  severity: SeveritySchema,
  title: z.string(),
  package: z.string().nullable(),
  dependencyId: z.string().nullable(),
  affectedVersion: z.string().nullable(),
  fixedVersion: z.string().nullable(),
  advisoryId: z.string().nullable(),
  advisorySource: z.string().nullable(),
  sourceUrl: z.string().nullable(),
  confidence: z.enum(["high", "medium", "low"]),
  riskBand: z.enum(["urgent", "high", "medium", "low"]),
  status: FindingStatusSchema,
  detectedAt: dt,
  lastSeenSha: sha,
  evidence: z.string(),
  suppression: z.object({ reason: z.string(), by: z.string(), at: dt, expiresAt: dt }).nullable(),
  taskId: z.string().nullable(),
});
export type Finding = z.infer<typeof FindingSchema>;

export const HealthSnapshotSchema = z.object({
  repositoryId: z.string(),
  weekStart: z.iso.date(),
  score: z.number(),
});
export type HealthSnapshot = z.infer<typeof HealthSnapshotSchema>;

export const ScanSchema = z.object({
  id: z.string(),
  repositoryId: z.string(),
  orgId: z.string(),
  commitSha: sha,
  status: z.enum(["queued", "running", "completed", "failed"]),
  trigger: z.enum(["schedule", "push", "manual", "onboarding"]),
  startedAt: dt,
  finishedAt: dt.nullable(),
  findingsCount: z.number().int().nullable(),
  scoreAfter: z.number().nullable(),
  scoreDelta: z.number().nullable(),
  changes: z.array(z.string()),
  config: z.object({ ecosystems: z.array(z.string()), checks: z.array(z.string()) }),
  simulatedEndsAt: z.number().optional(),
});
export type Scan = z.infer<typeof ScanSchema>;

export const TaskSchema = z.object({
  id: z.string(),
  orgId: z.string(),
  projectId: z.string(),
  repositoryId: z.string(),
  title: z.string(),
  description: z.string(),
  acceptanceCriteria: z.array(z.string()),
  constraints: z.array(z.string()),
  priority: PrioritySchema,
  status: TaskStatusSchema,
  source: TaskSourceSchema,
  sourceRef: z.string().nullable(),
  createdBy: z.string(),
  createdAt: dt,
  agentId: z.string().nullable(),
  baseSha: sha,
  targetBranch: z.string(),
  branch: z.string(),
  budgetUsd: z.number().nonnegative(),
  timeoutMin: z.number().positive(),
  parentTaskId: z.string().nullable(),
  bugId: z.string().nullable(),
  findingId: z.string().nullable(),
  pullRequestId: z.string().nullable(),
  assigneeId: z.string().nullable(),
  clarityWarning: z.string().nullable(),
});
export type Task = z.infer<typeof TaskSchema>;

export const ChangedFileSchema = z.object({
  path: z.string(),
  additions: z.number(),
  deletions: z.number(),
});

export const SessionSchema = z.object({
  id: z.string(),
  taskId: z.string(),
  orgId: z.string(),
  agentId: z.string(),
  attempt: z.number().int().positive(),
  status: SessionStatusSchema,
  startedAt: dt,
  endedAt: dt.nullable(),
  tokensIn: z.number().int(),
  tokensOut: z.number().int(),
  costUsd: z.number(),
  summary: z.string().nullable(),
  changedFiles: z.array(ChangedFileSchema),
  headSha: sha.nullable(),
  waitingFor: z
    .object({
      kind: z.enum(["approval", "clarification"]),
      approvalId: z.string().optional(),
      question: z.string().optional(),
    })
    .nullable(),
  notes: z.string().nullable(),
  logSeed: z.number(),
  simulated: z.boolean(),
  /** Mock-only: ms since epoch when the simulated session completes. */
  simulatedEndsAt: z.number().optional(),
  simulateFailure: z.boolean().optional(),
  /** Mock-only: when the simulated agent hits a protected action and asks for approval. */
  approvalCheckpointAt: z.number().optional(),
  pausedRemainingMs: z.number().optional(),
});
export type Session = z.infer<typeof SessionSchema>;

export const WorkspaceSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  orgId: z.string(),
  runtime: z.enum(["container", "worktree"]),
  image: z.string(),
  state: z.enum(["provisioning", "active", "cleaned"]),
  cpu: z.number(),
  memoryGb: z.number(),
  diskGb: z.number(),
  networkPolicy: z.enum(["none", "allowlist", "open"]),
  createdAt: dt,
  cleanupAt: dt,
  credentials: z.string(),
  baseSha: sha,
  branch: z.string(),
});
export type Workspace = z.infer<typeof WorkspaceSchema>;

export const PullRequestSchema = z.object({
  id: z.string(),
  orgId: z.string(),
  repositoryId: z.string(),
  number: z.number().int(),
  title: z.string(),
  url: z.url(),
  author: z.object({
    type: z.enum(["person", "agent"]),
    id: z.string(),
    sessionId: z.string().nullable(),
  }),
  openedBy: z.string(),
  branch: z.string(),
  baseSha: sha,
  headSha: sha,
  status: z.enum(["open", "merged", "closed"]),
  openedAt: dt,
  mergedAt: dt.nullable(),
  mergedBy: z.string().nullable(),
  aiAuthoredPct: z.number().min(0).max(100),
  additions: z.number(),
  deletions: z.number(),
  changedFiles: z.number(),
  taskId: z.string().nullable(),
  checkStatus: TestRunStatusSchema,
  reviewers: z.array(z.string()),
  reviewState: z.enum(["review_requested", "approved", "changes_requested"]),
  latestRunId: z.string().nullable(),
});
export type PullRequest = z.infer<typeof PullRequestSchema>;

export const TestRunSchema = z.object({
  id: z.string(),
  orgId: z.string(),
  repositoryId: z.string(),
  pullRequestId: z.string().nullable(),
  trigger: z.string(),
  headSha: sha,
  baseSha: sha,
  branch: z.string(),
  environment: z.object({
    name: z.string(),
    url: z.string().nullable(),
    node: z.string().nullable(),
    python: z.string().nullable(),
    worker: z.string(),
    region: z.string(),
  }),
  status: TestRunStatusSchema,
  startedAt: dt,
  finishedAt: dt.nullable(),
  durationSec: z.number().nullable(),
  selectedSuites: z.array(z.object({ suiteId: z.string(), reason: z.string() })),
  retestOf: z.string().nullable(),
  checkRun: z
    .object({
      name: z.string(),
      conclusion: z.enum(["success", "failure", "neutral"]).nullable(),
      detailsUrl: z.string(),
    })
    .nullable(),
  totals: z.object({
    passed: z.number(),
    failed: z.number(),
    flaky: z.number(),
    skipped: z.number(),
  }),
  billedBrowserMinutes: z.number(),
  infraError: z.string().optional(),
  simulatedEndsAt: z.number().optional(),
  simulateFailure: z.boolean().optional(),
});
export type TestRun = z.infer<typeof TestRunSchema>;

export const EvidenceRefSchema = z.object({
  kind: z.enum(["screenshot", "trace", "console", "network", "log", "video"]),
  label: z.string(),
  ref: z.string(),
});

export const TestResultSchema = z.object({
  id: z.string(),
  runId: z.string(),
  suiteId: z.string(),
  name: z.string(),
  outcome: TestOutcomeSchema,
  classification: FailureClassSchema.nullable(),
  durationMs: z.number(),
  retries: z.number().int(),
  error: z.string().nullable(),
  evidence: z.array(EvidenceRefSchema),
  firstFailedAt: dt.nullable(),
});
export type TestResult = z.infer<typeof TestResultSchema>;

export const BugSchema = z.object({
  id: z.string(),
  orgId: z.string(),
  repositoryId: z.string(),
  runId: z.string(),
  resultId: z.string(),
  pullRequestId: z.string().nullable(),
  title: z.string(),
  severity: SeveritySchema,
  status: z.enum(["open", "fix_in_progress", "resolved", "wont_fix"]),
  commitSha: sha,
  reproSteps: z.array(z.string()),
  stackTrace: z.string(),
  suspectedCause: z.string(),
  createdAt: dt,
  taskId: z.string().nullable(),
  assigneeId: z.string().nullable(),
});
export type Bug = z.infer<typeof BugSchema>;

export const ApprovalSchema = z.object({
  id: z.string(),
  orgId: z.string(),
  action: ApprovalActionSchema,
  status: ApprovalStatusSchema,
  title: z.string(),
  context: z.record(z.string(), z.unknown()),
  requestedBy: z.object({
    type: z.enum(["person", "agent"]),
    id: z.string(),
    sessionId: z.string().nullable(),
  }),
  requestedAt: dt,
  expiresAt: dt,
  approverRole: RoleSchema,
  decidedBy: z.string().nullable(),
  decidedAt: dt.nullable(),
  comment: z.string().nullable(),
});
export type Approval = z.infer<typeof ApprovalSchema>;

export const UsageRecordSchema = z.object({
  orgId: z.string(),
  date: z.iso.date(),
  projectId: z.string(),
  meter: MeterSchema,
  provider: z.string(),
  units: z.number().nonnegative(),
  costUsd: z.number().nonnegative(),
});
export type UsageRecord = z.infer<typeof UsageRecordSchema>;

export const InvoiceSchema = z.object({
  id: z.string(),
  orgId: z.string(),
  period: z.string(),
  status: z.enum(["paid", "open", "void"]),
  subscriptionUsd: z.number(),
  usageUsd: z.number(),
  totalUsd: z.number(),
  issuedAt: dt,
});
export type Invoice = z.infer<typeof InvoiceSchema>;

export const AuditLogSchema = z.object({
  id: z.string(),
  orgId: z.string(),
  actor: ActorRefSchema,
  action: z.string(),
  resource: z.string(),
  at: dt,
  detail: z.string(),
  ip: z.string().nullable(),
});
export type AuditLog = z.infer<typeof AuditLogSchema>;

export const NotificationSchema = z.object({
  id: z.string(),
  orgId: z.string(),
  userId: z.string().nullable(),
  kind: z.string(),
  title: z.string(),
  body: z.string(),
  href: z.string(),
  at: dt,
  read: z.boolean(),
});
export type Notification = z.infer<typeof NotificationSchema>;

export const ApiKeySchema = z.object({
  id: z.string(),
  orgId: z.string(),
  name: z.string(),
  prefix: z.string(),
  scopes: z.array(z.string()),
  createdBy: z.string(),
  createdAt: dt,
  lastUsedAt: dt.nullable(),
});
export type ApiKey = z.infer<typeof ApiKeySchema>;

/** ShipSafe visual comparison: baseline vs candidate screenshot for one page/viewport (PRD §7.5). */
export const VisualSnapshotSchema = z.object({
  id: z.string(),
  orgId: z.string(),
  runId: z.string(),
  pullRequestId: z.string().nullable(),
  repositoryId: z.string(),
  name: z.string(),
  route: z.string(),
  viewport: z.enum(["desktop", "mobile"]),
  theme: z.enum(["light", "dark"]),
  /** changed = waiting for an explicit baseline decision. */
  status: z.enum(["unchanged", "changed", "new", "approved", "rejected"]),
  diffPct: z.number().min(0).max(100),
  regions: z.array(z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() })),
  variant: z.number().int(),
  baselineSha: sha,
  candidateSha: sha,
  decidedBy: z.string().nullable(),
  decidedAt: dt.nullable(),
  comment: z.string().nullable(),
});
export type VisualSnapshot = z.infer<typeof VisualSnapshotSchema>;

/** An issue in a connected GitHub repository that can be imported as a DevPilot task (DP-010). */
export const GithubIssueSchema = z.object({
  id: z.string(),
  orgId: z.string(),
  repositoryId: z.string(),
  number: z.number().int(),
  title: z.string(),
  body: z.string(),
  labels: z.array(z.string()),
  author: z.string(),
  createdAt: dt,
  state: z.enum(["open", "closed"]),
  url: z.url(),
  comments: z.number().int(),
  importedTaskId: z.string().nullable(),
});
export type GithubIssue = z.infer<typeof GithubIssueSchema>;

export const MockDbSchema = z.object({
  meta: z.object({ note: z.string(), generatedAt: dt, version: z.number() }).loose(),
  users: z.array(UserSchema),
  organizations: z.array(OrganizationSchema),
  memberships: z.array(MembershipSchema),
  invitations: z.array(InvitationSchema),
  projects: z.array(ProjectSchema),
  repositories: z.array(RepositorySchema),
  integrations: z.array(IntegrationSchema),
  agents: z.array(AgentSchema),
  policies: z.array(PolicySchema),
  testSuites: z.array(TestSuiteSchema),
  visualSnapshots: z.array(VisualSnapshotSchema),
  githubIssues: z.array(GithubIssueSchema),
  dependencies: z.array(DependencySchema),
  findings: z.array(FindingSchema),
  healthHistory: z.array(HealthSnapshotSchema),
  scans: z.array(ScanSchema),
  tasks: z.array(TaskSchema),
  sessions: z.array(SessionSchema),
  workspaces: z.array(WorkspaceSchema),
  pullRequests: z.array(PullRequestSchema),
  testRuns: z.array(TestRunSchema),
  testResults: z.array(TestResultSchema),
  bugs: z.array(BugSchema),
  approvals: z.array(ApprovalSchema),
  usageRecords: z.array(UsageRecordSchema),
  invoices: z.array(InvoiceSchema),
  auditLogs: z.array(AuditLogSchema),
  notifications: z.array(NotificationSchema),
  apiKeys: z.array(ApiKeySchema),
});
export type MockDb = z.infer<typeof MockDbSchema>;
