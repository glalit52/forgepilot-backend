import { z } from "zod";

export const PlanIdSchema = z.enum(["free", "developer", "pro", "team", "business", "enterprise"]);
export type PlanId = z.infer<typeof PlanIdSchema>;

export const RoleSchema = z.enum(["owner", "admin", "member", "viewer"]);
export type Role = z.infer<typeof RoleSchema>;

export const WorkspaceKindSchema = z.enum(["personal", "team", "agency"]);
export type WorkspaceKind = z.infer<typeof WorkspaceKindSchema>;

export const ModuleSchema = z.enum(["devpilot", "shipsafe", "codekeeper"]);
export type Module = z.infer<typeof ModuleSchema>;

/** DevPilot task lifecycle. Review-ready only when completion conditions are met (PRD §6.4). */
export const TASK_STATUSES = [
  "draft",
  "queued",
  "running",
  "waiting_input",
  "verifying",
  "review_ready",
  "completed",
  "failed",
  "cancelled",
] as const;
export const TaskStatusSchema = z.enum(TASK_STATUSES);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

export const TaskSourceSchema = z.enum([
  "manual",
  "github_issue",
  "linear",
  "jira",
  "shipsafe_failure",
  "codekeeper_finding",
]);
export type TaskSource = z.infer<typeof TaskSourceSchema>;

export const PrioritySchema = z.enum(["urgent", "high", "medium", "low"]);
export type Priority = z.infer<typeof PrioritySchema>;

/** Agent session lifecycle (DP-004). */
export const SessionStatusSchema = z.enum([
  "queued",
  "running",
  "waiting",
  "completed",
  "failed",
  "cancelled",
]);
export type SessionStatus = z.infer<typeof SessionStatusSchema>;

export const ProviderSchema = z.enum(["claude_code", "openai_codex", "devin", "cursor"]);
export type Provider = z.infer<typeof ProviderSchema>;

export const TestRunStatusSchema = z.enum(["queued", "running", "passed", "failed", "errored"]);
export type TestRunStatus = z.infer<typeof TestRunStatusSchema>;

export const TestOutcomeSchema = z.enum(["passed", "failed", "flaky", "skipped"]);
export type TestOutcome = z.infer<typeof TestOutcomeSchema>;

/** SS-009: failures are classified so infra noise is never reported as a product defect. */
export const FailureClassSchema = z.enum([
  "product_defect",
  "test_defect",
  "environment",
  "flaky",
  "infrastructure",
]);
export type FailureClass = z.infer<typeof FailureClassSchema>;

export const SeveritySchema = z.enum(["critical", "high", "medium", "low"]);
export type Severity = z.infer<typeof SeveritySchema>;

export const FindingCategorySchema = z.enum([
  "vulnerability",
  "outdated",
  "build",
  "tests",
  "docs",
]);
export type FindingCategory = z.infer<typeof FindingCategorySchema>;

export const FindingStatusSchema = z.enum(["open", "task_created", "suppressed", "resolved"]);
export type FindingStatus = z.infer<typeof FindingStatusSchema>;

export const ApprovalActionSchema = z.enum([
  "modify_protected_path",
  "access_secret",
  "run_migration",
  "network_egress",
  "budget_increase",
  "create_pull_request",
  "deploy_production",
]);
export type ApprovalAction = z.infer<typeof ApprovalActionSchema>;

export const ApprovalStatusSchema = z.enum(["pending", "approved", "rejected", "expired"]);
export type ApprovalStatus = z.infer<typeof ApprovalStatusSchema>;

export const MeterSchema = z.enum([
  "agent_minutes",
  "browser_minutes",
  "test_runs",
  "scan_runs",
  "storage_gb",
]);
export type Meter = z.infer<typeof MeterSchema>;

export const HealthDimensionSchema = z.enum([
  "dependencies",
  "security",
  "buildStability",
  "tests",
  "docs",
]);
export type HealthDimension = z.infer<typeof HealthDimensionSchema>;
