import type { Role } from "../schemas";

/** Least privilege by default (PRD §16.3). Viewers read; members do the work; admins govern; owners own money. */
export const PERMISSIONS = {
  "task.create": ["owner", "admin", "member"],
  "task.launch": ["owner", "admin", "member"],
  "task.cancel": ["owner", "admin", "member"],
  "test.run": ["owner", "admin", "member"],
  "suite.manage": ["owner", "admin", "member"],
  "bug.manage": ["owner", "admin", "member"],
  "finding.create_task": ["owner", "admin", "member"],
  "finding.suppress": ["owner", "admin"],
  "pr.review": ["owner", "admin", "member"],
  "approval.decide": ["owner", "admin"],
  "repo.connect": ["owner", "admin"],
  "integration.manage": ["owner", "admin"],
  "policy.manage": ["owner", "admin"],
  "agent.manage": ["owner", "admin"],
  "member.manage": ["owner", "admin"],
  "apikey.manage": ["owner", "admin"],
  "billing.manage": ["owner"],
  "workspace.manage": ["owner"],
} as const satisfies Record<string, Role[]>;

export type Permission = keyof typeof PERMISSIONS;

export function can(role: Role | undefined, permission: Permission): boolean {
  return !!role && (PERMISSIONS[permission] as readonly Role[]).includes(role);
}

const RANK: Record<Role, number> = { viewer: 0, member: 1, admin: 2, owner: 3 };

/** Approvals name the minimum role that may decide them. */
export function meetsRole(role: Role | undefined, required: Role) {
  return !!role && RANK[role] >= RANK[required];
}

export const ROLE_LABEL: Record<Role, string> = {
  owner: "Owner",
  admin: "Admin",
  member: "Member",
  viewer: "Viewer",
};
export const ROLE_DESCRIPTION: Record<Role, string> = {
  owner: "Everything, including billing and deleting the workspace.",
  admin: "Manage members, integrations, policies and approvals.",
  member: "Create tasks, run agents and tests, review pull requests.",
  viewer: "Read-only access to every module.",
};

export const SESSION_COOKIE = "fp_session";
export const WORKSPACE_COOKIE = "fp_ws";
