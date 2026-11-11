/**
 * Request context and route definition for the API. Every endpoint is one
 * entry in a route table: method, path, required permission, request/response
 * schema and handler. The HTTP layer, the OpenAPI document and the contract
 * tests are all derived from that table.
 */
import type { z } from "zod";
import type { Organization, Role, User, DiffFile, LogLine } from "../contract/schemas";
import type { Permission } from "../contract/domain/permissions";
import type { TenantState } from "../tenancy/state";
import type { Queryable } from "../platform/db";
import type { IndexOutcome } from "./loop";

export type Auth = "public" | "authenticated" | "member" | Permission;

export interface WorkspaceMembership {
  organization: Organization;
  role: Role;
}

export interface Persona extends User {
  workspaces: { orgId: string; name: string; role: Role }[];
}

/** Everything the domain needs from the outside world, as narrow ports. */
export interface DomainPorts {
  readonly demoMode: boolean;
  readonly githubLive: boolean;
  readonly stripeLive: boolean;
  readonly appUrl: string;
  /** True when agents, test runs and scans execute for real instead of being simulated. */
  readonly executionLive: boolean;
  runs: { workerLog(orgId: string, runId: string): Promise<LogLine[] | null> };
  webhooks: {
    list(
      orgId: string,
    ): Promise<
      { id: string; url: string; events: string[]; enabled: boolean; createdAt: string }[]
    >;
    create(
      orgId: string,
      userId: string,
      input: { url: string; events: string[] },
    ): Promise<{
      endpoint: { id: string; url: string; events: string[]; enabled: boolean; createdAt: string };
      secret: string;
    }>;
    remove(orgId: string, id: string): Promise<boolean>;
  };
  externalIssues: {
    list(
      orgId: string,
      providerId: string,
    ): Promise<
      {
        key: string;
        title: string;
        body: string;
        url: string;
        labels: string[];
        priority: "urgent" | "high" | "medium" | "low";
        createdAt: string;
      }[]
    >;
  };
  personas(): Promise<Persona[]>;
  github: {
    /** Repositories the workspace's GitHub App installation can see. */
    listRepositories(orgId: string): Promise<
      {
        fullName: string;
        private: boolean;
        language: string;
        defaultBranch: string;
        pushedAt: string;
      }[]
    >;
    /** Verifies an installation id belongs to the app and returns the account it is installed on. */
    resolveInstallation(installationId: number): Promise<{ account: string }>;
    linkInstallation(
      q: Queryable,
      orgId: string,
      installationId: number,
      account: string,
    ): Promise<void>;
    unlinkInstallations(q: Queryable, orgId: string): Promise<void>;
    /** Metadata needed to register a repository before indexing completes. */
    describeRepository(
      orgId: string,
      fullName: string,
    ): Promise<Pick<IndexOutcome, "defaultBranch" | "private" | "headSha"> & { url: string }>;
    linkRepository(
      q: Queryable,
      orgId: string,
      repositoryId: string,
      fullName: string,
    ): Promise<void>;
    pullRequestDiff(orgId: string, fullName: string, number: number): Promise<DiffFile[]>;
  };
  credentials: {
    put(
      q: Queryable,
      orgId: string,
      providerId: string,
      secret: Record<string, string>,
    ): Promise<void>;
    remove(q: Queryable, orgId: string, providerId: string): Promise<void>;
    /** Checks a credential against the provider before it is stored. Throws HttpError(422) when rejected. */
    verify(providerId: string, secret: Record<string, string>): Promise<{ account?: string }>;
  };
  apiKeys: {
    register(
      q: Queryable,
      input: { orgId: string; keyId: string; secret: string; createdBy: string; role: Role },
    ): Promise<void>;
    revoke(q: Queryable, orgId: string, keyId: string): Promise<void>;
  };
  invitations: {
    /** Creates the single-use acceptance token; returns the link to email. */
    issue(
      q: Queryable,
      input: { orgId: string; invitationId: string; email: string },
    ): Promise<string>;
    revoke(q: Queryable, orgId: string, invitationId: string): Promise<void>;
  };
  sessions: {
    log(orgId: string, sessionId: string): Promise<LogLine[]>;
    diff(orgId: string, sessionId: string): Promise<DiffFile[] | null>;
  };
  billing: {
    paymentMethod(orgId: string): Promise<{ brand: string; last4: string; expires: string } | null>;
    portalUrl(orgId: string): Promise<string>;
    /** Live Stripe: moves the subscription to the plan, or throws 402 with a checkout URL. */
    changePlan(input: {
      org: Organization;
      plan: Organization["plan"];
      billingCycle: Organization["billingCycle"];
      userEmail: string;
      seats: number;
    }): Promise<void>;
  };
}

export interface Ctx {
  db: TenantState;
  user: User | null;
  orgId: string;
  role: Role | undefined;
  params: Record<string, string>;
  query: URLSearchParams;
  body: unknown;
  now: number;
  ip: string | null;
  /** Every workspace the caller belongs to. */
  workspaces: WorkspaceMembership[];
  ports: DomainPorts;
  /** Result of the route's `prepare` step, if it has one. */
  prepared?: unknown;
}

export interface RouteDef {
  method: "GET" | "POST";
  path: string;
  auth: Auth;
  summary: string;
  request?: z.ZodType;
  response: z.ZodType;
  /**
   * Network or other slow work a write needs. It runs against a read snapshot
   * before the transaction opens, so no external call ever holds the workspace lock.
   */
  prepare?: (ctx: Ctx) => Promise<unknown>;
  handler: (ctx: Ctx) => unknown | Promise<unknown>;
  /** Routes that were part of the UI contract generated from the web app. */
  contract?: boolean;
}
