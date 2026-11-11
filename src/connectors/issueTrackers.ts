/** Issue trackers that feed DevPilot: open issues from Linear and Jira, normalised to one shape. */
import type { Priority } from "../contract/schemas";
import type { Secret } from "./credentials";
import { assertProviderUrl } from "./credentials";
import { requestJson, type FetchLike } from "./http";

export interface ExternalIssue {
  /** Human key shown to users and stored as the task's source reference, e.g. ENG-142. */
  key: string;
  title: string;
  body: string;
  url: string;
  labels: string[];
  priority: Priority;
  createdAt: string;
}

const LINEAR_PRIORITY: Record<number, Priority> = { 1: "urgent", 2: "high", 3: "medium", 4: "low" };

/** Flattens Atlassian Document Format to plain text, keeping task-list and bullet structure. */
export function adfToText(node: unknown): string {
  if (!node || typeof node !== "object") return "";
  const n = node as {
    type?: string;
    text?: string;
    content?: unknown[];
    attrs?: { state?: string };
  };
  if (n.type === "text") return n.text ?? "";
  const inner = (n.content ?? []).map(adfToText).join("");
  switch (n.type) {
    case "paragraph":
    case "heading":
      return `${inner}\n`;
    case "listItem":
      return `- ${inner.trim()}\n`;
    case "taskItem":
      return `- [${n.attrs?.state === "DONE" ? "x" : " "}] ${inner.trim()}\n`;
    case "hardBreak":
      return "\n";
    default:
      return inner;
  }
}

export class IssueTrackers {
  constructor(private fetchImpl: FetchLike) {}

  async list(providerId: string, secret: Secret): Promise<ExternalIssue[]> {
    if (providerId === "linear") return this.linear(secret);
    if (providerId === "jira") return this.jira(secret);
    throw new Error(`No issue connector for ${providerId}`);
  }

  private async linear(secret: Secret): Promise<ExternalIssue[]> {
    const res = await requestJson<{
      data?: {
        issues: {
          nodes: {
            identifier: string;
            title: string;
            description: string | null;
            url: string;
            priority: number;
            createdAt: string;
            labels: { nodes: { name: string }[] };
          }[];
        };
      };
      errors?: { message: string }[];
    }>(this.fetchImpl, "linear", "https://api.linear.app/graphql", {
      method: "POST",
      retries: 1,
      headers: { Authorization: secret.apiKey },
      body: {
        query: `query OpenIssues {
          issues(first: 100, orderBy: createdAt, filter: { state: { type: { nin: ["completed", "canceled"] } } }) {
            nodes { identifier title description url priority createdAt labels { nodes { name } } }
          }
        }`,
      },
    });
    if (res.errors?.length || !res.data)
      throw new Error(`Linear: ${res.errors?.[0]?.message ?? "query failed"}`);
    return res.data.issues.nodes.map((i) => ({
      key: i.identifier,
      title: i.title,
      body: i.description ?? "",
      url: i.url,
      labels: i.labels.nodes.map((l) => l.name),
      priority: LINEAR_PRIORITY[i.priority] ?? "medium",
      createdAt: i.createdAt,
    }));
  }

  private async jira(secret: Secret): Promise<ExternalIssue[]> {
    const base = assertProviderUrl("jira", secret.baseUrl);
    const q = new URLSearchParams({
      jql: "statusCategory != Done ORDER BY created DESC",
      maxResults: "100",
      fields: "summary,description,labels,priority,created",
    });
    const res = await requestJson<{
      issues: {
        key: string;
        fields: {
          summary: string;
          description: unknown;
          labels?: string[];
          priority?: { name?: string } | null;
          created: string;
        };
      }[];
    }>(this.fetchImpl, "jira", `${base.origin}/rest/api/3/search/jql?${q}`, {
      headers: {
        Authorization: `Basic ${Buffer.from(`${secret.email}:${secret.apiToken}`).toString("base64")}`,
      },
    });
    const priority = (name = ""): Priority =>
      /highest|blocker|critical/i.test(name)
        ? "urgent"
        : /high/i.test(name)
          ? "high"
          : /low/i.test(name)
            ? "low"
            : "medium";
    return res.issues.map((i) => ({
      key: i.key,
      title: i.fields.summary,
      body: adfToText(i.fields.description).trim(),
      url: `${base.origin}/browse/${i.key}`,
      labels: i.fields.labels ?? [],
      priority: priority(i.fields.priority?.name),
      createdAt: i.fields.created,
    }));
  }
}
