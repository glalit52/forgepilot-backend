/**
 * Workspace routes beyond the web app's original contract: customer webhooks,
 * the billing portal and importing issues from Linear and Jira. Same rules as
 * the main table: permission per route, schema-checked responses.
 */
import { z } from "zod";
import * as S from "../contract/schemas";
import { HttpError } from "../platform/errors";
import type { Ctx, RouteDef } from "./context";
import { audit, startSession } from "./loop";
import { budgetRemaining } from "./views";
import { newId, toIso } from "./support";

function body<T>(schema: z.ZodType<T>, b: unknown): T {
  const r = schema.safeParse(b ?? {});
  if (!r.success) throw new HttpError(422, "Validation failed", z.flattenError(r.error));
  return r.data;
}
const person = (ctx: Ctx) => ({ type: "person" as const, id: ctx.user!.id });

const EndpointSchema = z.object({
  id: z.string(),
  url: z.string(),
  events: z.array(z.string()),
  enabled: z.boolean(),
  createdAt: z.string(),
});
const EndpointInputSchema = z.object({
  url: z.url().max(2000),
  /** Event types (`task.created`) or families (`task.*`). Empty = every event. */
  events: z
    .array(z.string().regex(/^[a-z_]+\.(\*|[a-z_]+)$/))
    .max(50)
    .default([]),
});
const ExternalIssueSchema = z.object({
  key: z.string(),
  title: z.string(),
  body: z.string(),
  url: z.string(),
  labels: z.array(z.string()),
  priority: S.PrioritySchema,
  createdAt: z.string(),
  importedTaskId: z.string().nullable(),
});
const ImportExternalSchema = z.object({
  keys: z.array(z.string()).min(1).max(50),
  repositoryId: z.string(),
  agentId: z.string(),
  launch: z.boolean().default(false),
});
const TRACKERS = ["linear", "jira"] as const;

function tracker(ctx: Ctx) {
  const id = ctx.params.providerId as (typeof TRACKERS)[number];
  if (!TRACKERS.includes(id)) throw new HttpError(404, "Unknown issue tracker");
  const connected = ctx.db.integrations.some(
    (i) => i.providerId === id && i.status === "connected",
  );
  if (!connected) throw new HttpError(409, `Connect ${id} in Integrations first`);
  return id;
}

export const extraRoutes: RouteDef[] = [
  {
    method: "GET",
    path: "/test-runs/:id/artifacts/:name",
    auth: "member",
    summary:
      "A stored evidence file of a test run, e.g. a suite's full output (the `ref` of a result's evidence).",
    response: z.object({ name: z.string(), contentType: z.string(), content: z.string() }),
    handler: async (ctx) => {
      // The run must belong to the caller's workspace before any storage lookup happens.
      if (!ctx.db.testRuns.some((r) => r.id === ctx.params.id))
        throw new HttpError(404, "Test run not found");
      if (!/^[A-Za-z0-9_.-]{1,120}$/.test(ctx.params.name) || ctx.params.name.includes(".."))
        throw new HttpError(404, "Artifact not found");
      const file = await ctx.ports.artifacts.read(ctx.orgId, ctx.params.id, ctx.params.name);
      if (!file) throw new HttpError(404, "Artifact not found");
      return { name: ctx.params.name, ...file };
    },
  },
  {
    method: "GET",
    path: "/webhook-endpoints",
    auth: "integration.manage",
    summary: "Customer webhook endpoints that receive signed workspace events.",
    response: z.array(EndpointSchema),
    handler: (ctx) => ctx.ports.webhooks.list(ctx.orgId),
  },
  {
    method: "POST",
    path: "/webhook-endpoints",
    auth: "integration.manage",
    summary:
      "Register a webhook endpoint (HTTPS, public address). The signing secret is returned once.",
    request: EndpointInputSchema,
    response: z.object({ endpoint: EndpointSchema, secret: z.string() }),
    prepare: (ctx) =>
      ctx.ports.webhooks.create(ctx.orgId, ctx.user!.id, body(EndpointInputSchema, ctx.body)),
    handler: (ctx) => {
      const created = ctx.prepared as { endpoint: z.infer<typeof EndpointSchema>; secret: string };
      audit(
        ctx.db,
        ctx.orgId,
        person(ctx),
        "webhook.created",
        `webhook:${created.endpoint.id}`,
        new URL(created.endpoint.url).host,
        ctx.now,
      );
      return created;
    },
  },
  {
    method: "POST",
    path: "/webhook-endpoints/:id/delete",
    auth: "integration.manage",
    summary: "Delete a webhook endpoint.",
    response: S.OkSchema,
    prepare: async (ctx) => {
      if (!(await ctx.ports.webhooks.remove(ctx.orgId, ctx.params.id)))
        throw new HttpError(404, "Webhook endpoint not found");
    },
    handler: (ctx) => {
      audit(
        ctx.db,
        ctx.orgId,
        person(ctx),
        "webhook.deleted",
        `webhook:${ctx.params.id}`,
        "",
        ctx.now,
      );
      return { ok: true as const };
    },
  },
  {
    method: "POST",
    path: "/billing/portal",
    auth: "billing.manage",
    summary: "A Stripe customer-portal link for invoices, payment method and cancellation.",
    response: z.object({ url: z.string() }),
    prepare: async (ctx) => {
      if (!ctx.ports.stripeLive)
        throw new HttpError(409, "Billing is not connected to Stripe in this environment");
      return ctx.ports.billing.portalUrl(ctx.orgId);
    },
    handler: (ctx) => ({ url: ctx.prepared as string }),
  },
  {
    method: "GET",
    path: "/integrations/:providerId/issues",
    auth: "member",
    summary:
      "Open issues in the connected Linear or Jira workspace, with whether each was already imported.",
    response: z.array(ExternalIssueSchema),
    handler: async (ctx) => {
      const id = tracker(ctx);
      const issues = await ctx.ports.externalIssues.list(ctx.orgId, id);
      return issues.map((i) => ({
        ...i,
        importedTaskId:
          ctx.db.tasks.find((t) => t.source === id && t.sourceRef === i.key)?.id ?? null,
      }));
    },
  },
  {
    method: "POST",
    path: "/integrations/:providerId/issues/import",
    auth: "task.create",
    summary: "Import Linear or Jira issues as DevPilot tasks. Already-imported issues are skipped.",
    request: ImportExternalSchema,
    response: S.ImportIssuesResultSchema,
    prepare: (ctx) => ctx.ports.externalIssues.list(ctx.orgId, tracker(ctx)),
    handler: (ctx) => {
      const id = tracker(ctx);
      const input = body(ImportExternalSchema, ctx.body);
      const issues = ctx.prepared as Awaited<ReturnType<Ctx["ports"]["externalIssues"]["list"]>>;
      const repo = ctx.db.repositories.find((r) => r.id === input.repositoryId);
      if (!repo) throw new HttpError(404, "Repository not found");
      const agent = ctx.db.agents.find((a) => a.id === input.agentId);
      if (!agent) throw new HttpError(404, "Agent not found");
      if (!ctx.db.policies[0].allowedProviders.includes(agent.provider))
        throw new HttpError(409, `${agent.name} is not allowed by workspace policy`);
      const org = ctx.db.organizations[0];
      if (input.launch && org.budget.hardCap && budgetRemaining(ctx.db, ctx.orgId, ctx.now) <= 0)
        throw new HttpError(
          402,
          "Monthly budget exhausted (hard cap). Raise the budget in Billing.",
        );
      const tasks: S.Task[] = [];
      const skipped: string[] = [];
      for (const key of input.keys) {
        const issue = issues.find((i) => i.key === key);
        if (!issue) {
          skipped.push(`${key} was not found or is no longer open`);
          continue;
        }
        const existing = ctx.db.tasks.find((t) => t.source === id && t.sourceRef === key);
        if (existing) {
          skipped.push(`${key} is already task ${existing.id}`);
          continue;
        }
        const checklist = issue.body
          .split("\n")
          .map((l) => l.match(/^\s*[-*]\s*\[[ xX]?\]\s*(.+)$/)?.[1]?.trim())
          .filter((x): x is string => !!x && x.length >= 3);
        const taskId = newId("task");
        const task: S.Task = {
          id: taskId,
          orgId: ctx.orgId,
          projectId: repo.projectId,
          repositoryId: repo.id,
          title: issue.title.slice(0, 200),
          description:
            `Imported from ${id === "linear" ? "Linear" : "Jira"} issue ${key} (${issue.url}).\n\n${issue.body}`.slice(
              0,
              2000,
            ),
          acceptanceCriteria: checklist.length
            ? checklist
            : [`${issue.title} works as described in the issue`, "Tests added and passing"],
          constraints: ["Keep public APIs backwards compatible"],
          priority: issue.priority,
          status: "draft",
          source: id,
          sourceRef: key,
          createdBy: ctx.user!.id,
          createdAt: toIso(ctx.now),
          agentId: agent.id,
          baseSha: repo.indexedSha,
          targetBranch: repo.defaultBranch,
          branch: `fp/${taskId}-${key.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
          budgetUsd: agent.defaultBudgetUsd,
          timeoutMin: agent.defaultTimeoutMin,
          parentTaskId: null,
          bugId: null,
          findingId: null,
          pullRequestId: null,
          assigneeId: ctx.user!.id,
          clarityWarning:
            checklist.length < 2
              ? "Vague tasks produce vague PRs: add more acceptance criteria or detail."
              : null,
        };
        ctx.db.tasks.push(task);
        audit(
          ctx.db,
          ctx.orgId,
          person(ctx),
          "issue.imported",
          `task:${task.id}`,
          `${key} ${issue.title}`,
          ctx.now,
        );
        if (input.launch) startSession(ctx.db, task, person(ctx), { now: ctx.now });
        tasks.push(task);
      }
      return { tasks, skipped };
    },
  },
];
