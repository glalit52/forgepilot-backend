/**
 * Account-level routes: sign-up, sign-in, workspace creation and switching,
 * invitations, password reset and the demo controls. They run outside any
 * workspace, so they use SQL directly instead of the tenant store.
 */
import { z } from "zod";
import * as S from "../contract/schemas";
import type { User } from "../contract/schemas";
import type { WorkspaceMembership } from "../domain/context";
import { HttpError } from "../platform/errors";
import { newId, toIso } from "../platform/ids";
import type { App } from "../app";
import { createWorkspace } from "./provisioning";

export interface GlobalCtx {
  app: App;
  user: User | null;
  workspaces: WorkspaceMembership[];
  /** The workspace selected by the fp_ws cookie, if the user is a member of it. */
  activeOrgId: string | null;
  params: Record<string, string>;
  query: URLSearchParams;
  body: unknown;
  now: number;
  ip: string | null;
  userAgent: string | null;
  session: {
    token: string | undefined;
    /** Starts a browser session for the user and selects a workspace ("" = none yet). */
    start(userId: string, orgId: string): Promise<void>;
    selectWorkspace(orgId: string): void;
    end(): Promise<void>;
  };
}

export interface GlobalRouteDef {
  method: "GET" | "POST";
  path: string;
  auth: "public" | "authenticated";
  summary: string;
  request?: z.ZodType;
  response: z.ZodType;
  handler: (ctx: GlobalCtx) => Promise<unknown>;
  contract?: boolean;
  /** Stricter rate limit for credential-guessing surfaces. */
  sensitive?: boolean;
}

function body<T>(schema: z.ZodType<T>, b: unknown): T {
  const r = schema.safeParse(b ?? {});
  if (!r.success) throw new HttpError(422, "Validation failed", z.flattenError(r.error));
  return r.data;
}

function me(ctx: GlobalCtx): User {
  if (!ctx.user) throw new HttpError(401, "Not signed in");
  return ctx.user;
}

/** The same payload as GET /session, for the workspace just selected. */
async function sessionInfo(ctx: GlobalCtx, user: User, orgId: string) {
  const workspaces = await ctx.app.identity.membershipsOf(user.id);
  const membership = workspaces.find((w) => w.organization.id === orgId);
  if (!membership) throw new HttpError(403, "Not a member of that workspace");
  const route = ctx.app.tenantRoutes.routes.find(
    (r) => r.method === "GET" && r.path === "/session",
  )!;
  return ctx.app.engine.run(
    route,
    { user, orgId, role: membership.role, workspaces },
    { params: {}, query: new URLSearchParams(), body: undefined, ip: ctx.ip, now: ctx.now },
  );
}

const PasswordSchema = z
  .string()
  .min(10, "Use at least 10 characters")
  .max(200, "Use at most 200 characters");

/** Additive to the UI contract: the web app's demo form sends no password. */
const SignUpSchema = S.SignUpInputSchema.extend({
  password: PasswordSchema.optional(),
  invitationToken: z.string().optional(),
});
const LoginSchema = z.object({ email: z.email(), password: z.string().min(1).max(200) });
const AuthResultSchema = z.object({ user: S.UserSchema, hasWorkspace: z.boolean() });
const PersonaSchema = S.UserSchema.extend({
  workspaces: z.array(z.object({ orgId: z.string(), name: z.string(), role: S.RoleSchema })),
});

async function acceptInvitation(ctx: GlobalCtx, user: User, token: string): Promise<string> {
  const inv = await ctx.app.identity.findInvitation(token);
  if (!inv) throw new HttpError(404, "This invitation link is invalid or has expired");
  if (inv.email.toLowerCase() !== user.email.toLowerCase())
    throw new HttpError(
      403,
      `This invitation was sent to ${inv.email}. Sign in with that address.`,
    );
  await ctx.app.store.write(inv.orgId, async (db, effects) => {
    const invitation = db.invitations.find((i) => i.id === inv.invitationId);
    if (!invitation || invitation.status !== "pending")
      throw new HttpError(409, "This invitation is no longer pending");
    invitation.status = "accepted";
    if (!db.memberships.some((m) => m.userId === user.id))
      db.memberships.push({
        orgId: inv.orgId,
        userId: user.id,
        role: invitation.role,
        joinedAt: toIso(ctx.now),
      });
    db.auditLogs.unshift({
      id: newId("aud"),
      orgId: inv.orgId,
      actor: { type: "person", id: user.id },
      action: "member.joined",
      resource: `user:${user.id}`,
      at: toIso(ctx.now),
      detail: `${user.email} as ${invitation.role}`,
      ip: ctx.ip,
    });
    await ctx.app.identity.revokeInvitation(effects.q!, inv.orgId, inv.invitationId);
  });
  return inv.orgId;
}

export const identityRoutes: GlobalRouteDef[] = [
  {
    method: "GET",
    path: "/session/personas",
    auth: "public",
    contract: true,
    summary: "Demo personas for the sign-in screen.",
    response: z.array(PersonaSchema),
    handler: (ctx) => ctx.app.identity.personas(),
  },
  {
    method: "GET",
    path: "/session/status",
    auth: "public",
    contract: true,
    summary:
      "Whether the visitor is signed in and has a workspace (used by onboarding before a workspace exists).",
    response: z.object({
      signedIn: z.boolean(),
      hasWorkspace: z.boolean(),
      name: z.string().nullable(),
    }),
    handler: async (ctx) => ({
      signedIn: !!ctx.user,
      hasWorkspace: ctx.workspaces.length > 0,
      name: ctx.user?.name ?? null,
    }),
  },
  {
    method: "POST",
    path: "/session",
    auth: "public",
    contract: true,
    sensitive: true,
    summary: "Sign in as a demo persona (sets fp_session and fp_ws cookies).",
    request: S.SignInInputSchema,
    response: S.SessionInfoSchema,
    handler: async (ctx) => {
      // Persona sign-in has no password, so it only exists for fictional demo accounts.
      if (!ctx.app.config.demoMode)
        throw new HttpError(403, "Demo sign-in is disabled. Sign in with your email or GitHub.");
      const { userId, orgId } = body(S.SignInInputSchema, ctx.body);
      const persona = (await ctx.app.identity.personas()).find((p) => p.id === userId);
      if (!persona) throw new HttpError(404, "Unknown user");
      const target = orgId ?? persona.workspaces[0]?.orgId;
      if (!target || !persona.workspaces.some((w) => w.orgId === target))
        throw new HttpError(403, "Not a member of that workspace");
      await ctx.session.start(persona.id, target);
      const { workspaces: _w, ...user } = persona;
      return sessionInfo(ctx, user, target);
    },
  },
  {
    method: "POST",
    path: "/session/workspace",
    auth: "authenticated",
    contract: true,
    summary: "Switch the active workspace.",
    request: S.SwitchWorkspaceInputSchema,
    response: S.SessionInfoSchema,
    handler: async (ctx) => {
      const { orgId } = body(S.SwitchWorkspaceInputSchema, ctx.body);
      const info = await sessionInfo(ctx, me(ctx), orgId);
      ctx.session.selectWorkspace(orgId);
      return info;
    },
  },
  {
    method: "POST",
    path: "/signup",
    auth: "public",
    contract: true,
    sensitive: true,
    summary:
      "Create an account (mock GitHub OAuth or email). The user then creates a workspace in onboarding.",
    request: S.SignUpInputSchema,
    response: S.UserSchema,
    handler: async (ctx) => {
      const input = body(SignUpSchema, ctx.body);
      const { demoMode } = ctx.app.config;
      // Outside the demo an account always has a credential: a password here, or GitHub via /auth/github/start.
      if (!demoMode && input.method === "github")
        throw new HttpError(409, "Continue with GitHub to sign up with your GitHub account.", {
          redirect: `${ctx.app.config.publicApiUrl}/auth/github/start`,
        });
      if (!demoMode && !input.password)
        throw new HttpError(422, "Validation failed", {
          formErrors: [],
          fieldErrors: { password: ["Choose a password"] },
        });
      const user = await ctx.app.identity.createUser({
        name: input.name,
        email: input.email,
        password: input.password,
        githubLogin: demoMode && input.method === "github" ? input.email.split("@")[0] : undefined,
      });
      let orgId = "";
      if (input.invitationToken) orgId = await acceptInvitation(ctx, user, input.invitationToken);
      await ctx.session.start(user.id, orgId);
      return user;
    },
  },
  {
    method: "POST",
    path: "/orgs",
    auth: "authenticated",
    contract: true,
    summary:
      "Create a workspace for the signed-in user (owner, Free plan with a 14-day Team trial).",
    request: S.CreateWorkspaceInputSchema,
    response: S.OrganizationSchema,
    handler: async (ctx) => {
      const user = me(ctx);
      const input = body(S.CreateWorkspaceInputSchema, ctx.body);
      const owned = ctx.workspaces.filter((w) => w.role === "owner").length;
      if (owned >= 20) throw new HttpError(409, "You own the maximum number of workspaces.");
      const org = await ctx.app.db.tx((q) =>
        createWorkspace(q, ctx.app.store, user, input, {
          now: ctx.now,
          mode: ctx.app.config.execution.mode,
          isDemo: ctx.app.config.demoMode,
          ip: ctx.ip,
        }),
      );
      ctx.session.selectWorkspace(org.id);
      return org;
    },
  },
  {
    method: "POST",
    path: "/demo/reset",
    auth: "public",
    contract: true,
    sensitive: true,
    summary: "Reset all mock data to the seed (demo mode).",
    response: S.OkSchema,
    handler: async (ctx) => {
      if (!ctx.app.config.demoMode) throw new HttpError(404, "Not available");
      await ctx.app.resetDemo();
      return { ok: true };
    },
  },

  // ===== real authentication (not part of the demo UI contract)
  {
    method: "GET",
    path: "/auth/options",
    auth: "public",
    summary:
      "Which sign-in methods this deployment offers, so the web app shows the right screens.",
    response: z.object({
      demo: z.boolean(),
      password: z.boolean(),
      github: z.boolean(),
      githubSignInUrl: z.string().nullable(),
      githubAppInstallUrl: z.string().nullable(),
    }),
    handler: async (ctx) => ({
      demo: ctx.app.config.demoMode,
      password: !ctx.app.config.demoMode,
      github: ctx.app.github.oauthConfigured,
      githubSignInUrl: ctx.app.github.oauthConfigured
        ? `${ctx.app.config.publicApiUrl}/auth/github/start`
        : null,
      githubAppInstallUrl: ctx.app.github.configured ? ctx.app.github.installUrl : null,
    }),
  },
  {
    method: "POST",
    path: "/auth/login",
    auth: "public",
    sensitive: true,
    summary: "Sign in with email and password. Sets the session cookies.",
    request: LoginSchema,
    response: AuthResultSchema,
    handler: async (ctx) => {
      const input = body(LoginSchema, ctx.body);
      const user = await ctx.app.identity.checkPassword(input.email, input.password);
      // One message for every failure so the endpoint can't be used to find registered emails.
      if (!user) throw new HttpError(401, "Wrong email or password");
      const workspaces = await ctx.app.identity.membershipsOf(user.id);
      await ctx.session.start(user.id, workspaces[0]?.organization.id ?? "");
      return { user, hasWorkspace: workspaces.length > 0 };
    },
  },
  {
    method: "POST",
    path: "/auth/logout",
    auth: "public",
    summary: "End the current session and clear the cookies.",
    response: S.OkSchema,
    handler: async (ctx) => {
      await ctx.session.end();
      return { ok: true };
    },
  },
  {
    method: "POST",
    path: "/auth/logout-everywhere",
    auth: "authenticated",
    summary: "End every session of the signed-in user, on all devices.",
    response: S.OkSchema,
    handler: async (ctx) => {
      await ctx.app.identity.destroyAllSessions(me(ctx).id);
      await ctx.session.end();
      return { ok: true };
    },
  },
  {
    method: "POST",
    path: "/auth/password/forgot",
    auth: "public",
    sensitive: true,
    summary:
      "Email a password-reset link. Always answers ok, whether or not the address is registered.",
    request: z.object({ email: z.email() }),
    response: S.OkSchema,
    handler: async (ctx) => {
      const { email } = body(z.object({ email: z.email() }), ctx.body);
      const user = await ctx.app.identity.findByEmail(email);
      if (user) {
        const token = await ctx.app.identity.issuePasswordReset(user.id);
        await ctx.app.enqueue({
          kind: "email.send",
          payload: {
            to: user.email,
            template: "password_reset",
            data: {
              name: user.name,
              link: `${ctx.app.config.appUrl}/reset-password?token=${token}`,
            },
          },
        });
      }
      return { ok: true };
    },
  },
  {
    method: "POST",
    path: "/auth/password/reset",
    auth: "public",
    sensitive: true,
    summary: "Set a new password with a reset token. Signs out every existing session.",
    request: z.object({ token: z.string().min(20), password: PasswordSchema }),
    response: S.OkSchema,
    handler: async (ctx) => {
      const input = body(
        z.object({ token: z.string().min(20), password: PasswordSchema }),
        ctx.body,
      );
      if (!(await ctx.app.identity.consumePasswordReset(input.token, input.password)))
        throw new HttpError(400, "This reset link is invalid or has expired");
      return { ok: true };
    },
  },
  {
    method: "GET",
    path: "/me",
    auth: "authenticated",
    summary: "The signed-in user and the workspaces they belong to.",
    response: z.object({ user: S.UserSchema, workspaces: z.array(S.WorkspaceMembershipSchema) }),
    handler: async (ctx) => ({ user: me(ctx), workspaces: ctx.workspaces }),
  },
  {
    method: "POST",
    path: "/me",
    auth: "authenticated",
    summary: "Update the signed-in user's profile.",
    request: z.object({
      name: z.string().trim().min(2).max(80).optional(),
      title: z.string().trim().max(80).optional(),
    }),
    response: S.UserSchema,
    handler: async (ctx) =>
      ctx.app.identity.updateProfile(
        me(ctx).id,
        body(
          z.object({
            name: z.string().trim().min(2).max(80).optional(),
            title: z.string().trim().max(80).optional(),
          }),
          ctx.body,
        ),
      ),
  },
  {
    method: "GET",
    path: "/invitations/lookup",
    auth: "public",
    sensitive: true,
    summary:
      "What an invitation link is for, shown before the invitee signs up or signs in. ?token=",
    response: z.object({ workspace: z.string(), email: z.string(), role: S.RoleSchema }),
    handler: async (ctx) => {
      const inv = await ctx.app.identity.findInvitation(ctx.query.get("token") ?? "");
      if (!inv) throw new HttpError(404, "This invitation link is invalid or has expired");
      const state = await ctx.app.store.read(inv.orgId);
      const invitation = state.invitations.find((i) => i.id === inv.invitationId);
      if (!invitation || invitation.status !== "pending")
        throw new HttpError(404, "This invitation link is invalid or has expired");
      return { workspace: state.organizations[0].name, email: inv.email, role: invitation.role };
    },
  },
  {
    method: "POST",
    path: "/invitations/accept",
    auth: "authenticated",
    summary:
      "Join the workspace an invitation was issued for. The invitation's email must match the account.",
    request: z.object({ token: z.string().min(20) }),
    response: S.OrganizationSchema,
    handler: async (ctx) => {
      const { token } = body(z.object({ token: z.string().min(20) }), ctx.body);
      const orgId = await acceptInvitation(ctx, me(ctx), token);
      ctx.session.selectWorkspace(orgId);
      return (await ctx.app.store.read(orgId)).organizations[0];
    },
  },
];
