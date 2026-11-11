import type { IntegrationCategory } from "../schemas";

export interface IntegrationProvider {
  id: string;
  name: string;
  category: IntegrationCategory;
  description: string;
  availability: "available" | "beta" | "coming_soon" | "enterprise";
  scopes: string[];
  /** Neutral monogram tile; no third-party logos. */
  monogram: string;
}

export const INTEGRATION_CATEGORY_LABEL: Record<IntegrationCategory, string> = {
  source_control: "Source control",
  agents: "Coding agents",
  issues: "Issues & planning",
  notifications: "Notifications",
  observability: "Observability",
  security: "Security & advisories",
  identity: "Identity & SSO",
};

export const INTEGRATION_PROVIDERS: IntegrationProvider[] = [
  {
    id: "github",
    name: "GitHub",
    category: "source_control",
    monogram: "GH",
    availability: "available",
    description:
      "GitHub App on the repositories you pick. Reads code, opens PRs, posts Check Runs.",
    scopes: ["contents:read", "pull_requests:write", "checks:write", "issues:read"],
  },
  {
    id: "gitlab",
    name: "GitLab",
    category: "source_control",
    monogram: "GL",
    availability: "coming_soon",
    description: "Merge request verification and maintenance for GitLab.",
    scopes: [],
  },
  {
    id: "claude_code",
    name: "Claude Code",
    category: "agents",
    monogram: "CC",
    availability: "available",
    description: "Run Claude Code in isolated workspaces with your Anthropic API key.",
    scopes: ["agent:run"],
  },
  {
    id: "openai_codex",
    name: "OpenAI Codex",
    category: "agents",
    monogram: "OX",
    availability: "available",
    description: "Run Codex tasks through the supported OpenAI interface.",
    scopes: ["agent:run"],
  },
  {
    id: "devin",
    name: "Devin",
    category: "agents",
    monogram: "DV",
    availability: "coming_soon",
    description: "Delegate tasks to Devin once its integration is verified.",
    scopes: [],
  },
  {
    id: "cursor",
    name: "Cursor background agents",
    category: "agents",
    monogram: "CU",
    availability: "coming_soon",
    description: "Track Cursor background agent work alongside other runtimes.",
    scopes: [],
  },
  {
    id: "linear",
    name: "Linear",
    category: "issues",
    monogram: "LI",
    availability: "available",
    description: "Import issues as DevPilot tasks and sync status back.",
    scopes: ["issues:read"],
  },
  {
    id: "jira",
    name: "Jira",
    category: "issues",
    monogram: "JI",
    availability: "available",
    description: "Import Jira issues as tasks; comment with verification results.",
    scopes: ["issues:read"],
  },
  {
    id: "slack",
    name: "Slack",
    category: "notifications",
    monogram: "SL",
    availability: "available",
    description: "Approval requests, failed checks and review-ready PRs in a channel.",
    scopes: ["chat:write"],
  },
  {
    id: "teams",
    name: "Microsoft Teams",
    category: "notifications",
    monogram: "MT",
    availability: "beta",
    description: "Approval requests and alerts in Teams.",
    scopes: ["ChannelMessage.Send"],
  },
  {
    id: "sentry",
    name: "Sentry",
    category: "observability",
    monogram: "SE",
    availability: "beta",
    description: "Link production errors to the PRs and tasks that changed that code.",
    scopes: ["events:read"],
  },
  {
    id: "datadog",
    name: "Datadog",
    category: "observability",
    monogram: "DD",
    availability: "coming_soon",
    description: "Correlate deploys with monitors.",
    scopes: [],
  },
  {
    id: "osv",
    name: "OSV & GitHub Advisory DB",
    category: "security",
    monogram: "OS",
    availability: "available",
    description: "Built-in advisory sources for CodeKeeper. Always on.",
    scopes: [],
  },
  {
    id: "snyk",
    name: "Snyk",
    category: "security",
    monogram: "SY",
    availability: "beta",
    description: "Import existing Snyk findings into the maintenance queue.",
    scopes: ["projects:read"],
  },
  {
    id: "okta",
    name: "Okta",
    category: "identity",
    monogram: "OK",
    availability: "enterprise",
    description: "SAML SSO and SCIM provisioning.",
    scopes: [],
  },
  {
    id: "entra",
    name: "Microsoft Entra ID",
    category: "identity",
    monogram: "EN",
    availability: "enterprise",
    description: "SAML SSO with Entra ID.",
    scopes: [],
  },
];

export function providerById(id: string) {
  return INTEGRATION_PROVIDERS.find((p) => p.id === id);
}
