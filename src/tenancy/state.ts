/**
 * The shape of one workspace's data as the domain logic sees it: plain arrays
 * of contract entities. The store materialises it from Postgres and persists
 * whatever a write changed.
 */
import type { z } from "zod";
import * as S from "../contract/schemas";
import type { JobInput } from "../platform/jobs";
import type { Queryable } from "../platform/db";

export type TenantState = Omit<S.MockDb, "meta">;
export type CollectionName = keyof TenantState;

interface CollectionSpec {
  schema: z.ZodType;
  /** desc = newest first in the array (the domain prepends); asc = insertion order. */
  order: "asc" | "desc";
  /** Natural key for entities that have no `id` field. */
  key?: (entity: never) => string;
}

/** Collections persisted in `tenant_records`. Users, the organization and memberships have their own tables. */
export const RECORD_COLLECTIONS = {
  invitations: { schema: S.InvitationSchema, order: "asc" },
  projects: { schema: S.ProjectSchema, order: "asc" },
  repositories: { schema: S.RepositorySchema, order: "asc" },
  integrations: { schema: S.IntegrationSchema, order: "asc" },
  agents: { schema: S.AgentSchema, order: "asc" },
  policies: { schema: S.PolicySchema, order: "asc", key: () => "policy" },
  testSuites: { schema: S.TestSuiteSchema, order: "asc" },
  visualSnapshots: { schema: S.VisualSnapshotSchema, order: "asc" },
  githubIssues: { schema: S.GithubIssueSchema, order: "asc" },
  dependencies: { schema: S.DependencySchema, order: "asc" },
  findings: { schema: S.FindingSchema, order: "asc" },
  healthHistory: {
    schema: S.HealthSnapshotSchema,
    order: "asc",
    key: (h: S.HealthSnapshot) => `${h.repositoryId}:${h.weekStart}`,
  },
  scans: { schema: S.ScanSchema, order: "desc" },
  tasks: { schema: S.TaskSchema, order: "asc" },
  sessions: { schema: S.SessionSchema, order: "asc" },
  workspaces: { schema: S.WorkspaceSchema, order: "asc" },
  pullRequests: { schema: S.PullRequestSchema, order: "asc" },
  testRuns: { schema: S.TestRunSchema, order: "asc" },
  testResults: { schema: S.TestResultSchema, order: "asc" },
  bugs: { schema: S.BugSchema, order: "asc" },
  approvals: { schema: S.ApprovalSchema, order: "desc" },
  usageRecords: { schema: S.UsageRecordSchema, order: "asc" },
  invoices: { schema: S.InvoiceSchema, order: "asc" },
  auditLogs: { schema: S.AuditLogSchema, order: "desc" },
  notifications: { schema: S.NotificationSchema, order: "desc" },
  apiKeys: { schema: S.ApiKeySchema, order: "asc" },
} as const satisfies Partial<Record<CollectionName, CollectionSpec>>;

export type RecordCollection = keyof typeof RECORD_COLLECTIONS;
export const RECORD_COLLECTION_NAMES = Object.keys(RECORD_COLLECTIONS) as RecordCollection[];

export function emptyState(): TenantState {
  const state = { users: [], organizations: [], memberships: [] } as unknown as TenantState;
  for (const name of RECORD_COLLECTION_NAMES) (state[name] as unknown[]) = [];
  return state;
}

export type ExecutionMode = "simulated" | "live";

/** Side effects a domain write may request; they are applied atomically with the state change. */
export interface Effects {
  readonly mode: ExecutionMode;
  readonly sim: { runMs: number; verifyMs: number; scanMs: number; indexMs: number };
  /** Enqueue a background job in the same transaction as this write. */
  enqueue(job: JobInput): void;
  /** Run after the transaction commits (never on rollback). */
  afterCommit(fn: () => void | Promise<void>): void;
  /** The open transaction, for writes to side tables (credentials, logs, links). Null on reads. */
  readonly q: Queryable | null;
}

const EFFECTS = new WeakMap<object, Effects>();

export function bindEffects(state: TenantState, effects: Effects) {
  EFFECTS.set(state, effects);
}

/** Effects for the write (or read) this state belongs to. */
export function fx(state: TenantState): Effects {
  const e = EFFECTS.get(state);
  if (!e) throw new Error("State is not bound to a store operation");
  return e;
}
