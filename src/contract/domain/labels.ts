import type {
  ApprovalAction,
  FindingCategory,
  Priority,
  Provider,
  TaskSource,
  WorkspaceKind,
} from "../schemas";

export const PROVIDER_LABEL: Record<Provider, string> = {
  claude_code: "Claude Code",
  openai_codex: "OpenAI Codex",
  devin: "Devin",
  cursor: "Cursor background agents",
};

export const PRIORITY_LABEL: Record<Priority, string> = {
  urgent: "Urgent",
  high: "High",
  medium: "Medium",
  low: "Low",
};

export const TASK_SOURCE_LABEL: Record<TaskSource, string> = {
  manual: "Created manually",
  github_issue: "GitHub issue",
  linear: "Linear",
  jira: "Jira",
  shipsafe_failure: "ShipSafe failure",
  codekeeper_finding: "CodeKeeper finding",
};

export const FINDING_CATEGORY_LABEL: Record<FindingCategory, string> = {
  vulnerability: "Vulnerability",
  outdated: "Outdated dependency",
  build: "Build stability",
  tests: "Test reliability",
  docs: "Documentation",
};

export const APPROVAL_ACTION_LABEL: Record<ApprovalAction, string> = {
  modify_protected_path: "Modify protected path",
  access_secret: "Access a secret",
  run_migration: "Run a database migration",
  network_egress: "Network access outside allowlist",
  budget_increase: "Increase budget",
  create_pull_request: "Create pull request",
  deploy_production: "Deploy to production",
};

export const WORKSPACE_KIND_LABEL: Record<WorkspaceKind, string> = {
  personal: "Personal",
  team: "Team",
  agency: "Agency",
};

export const USE_CASE_LABEL: Record<string, string> = {
  ship_ai_code_safely: "Ship AI-written code safely",
  verify_prs: "Verify pull requests automatically",
  maintain_repos: "Keep repositories healthy",
  coordinate_agents: "Coordinate coding agents",
  agency_client_repos: "Maintain client repositories",
  personal_projects: "Personal projects",
};

export function shortSha(sha: string | null | undefined) {
  return sha ? sha.slice(0, 7) : "—";
}
