/**
 * Executes routes from the workspace route table against the tenant store.
 *  GET  → handler runs on an immutable snapshot
 *  POST → optional `prepare` (network, outside any lock), then the handler runs
 *         inside one workspace transaction; everything it changed commits atomically
 */
import { z } from "zod";
import type { Role, User } from "../contract/schemas";
import { can } from "../contract/domain/permissions";
import { HttpError } from "../platform/errors";
import type { Logger } from "../platform/logger";
import type { TenantStore } from "../tenancy/store";
import type { TenantState, Effects } from "../tenancy/state";
import type { Ctx, DomainPorts, RouteDef, WorkspaceMembership } from "./context";
import { advance, bindRequest, nextDueAt } from "./loop";

export interface Principal {
  user: User;
  orgId: string;
  role: Role;
  workspaces: WorkspaceMembership[];
}

export interface RouteRequest {
  params: Record<string, string>;
  query: URLSearchParams;
  body: unknown;
  ip: string | null;
  now?: number;
}

interface Compiled {
  route: RouteDef;
  segments: string[];
}

export class RouteTable {
  private compiled: Compiled[];

  constructor(readonly routes: RouteDef[]) {
    this.compiled = routes.map((route) => ({
      route,
      segments: route.path.split("/").filter(Boolean),
    }));
  }

  /** Returns the route and its path parameters; `methodMismatch` distinguishes 405 from 404. */
  match(
    method: string,
    path: string,
  ): { route: RouteDef; params: Record<string, string> } | { methodMismatch: boolean } {
    const parts = path.split("/").filter(Boolean);
    let methodMismatch = false;
    for (const { route, segments } of this.compiled) {
      if (segments.length !== parts.length) continue;
      const params: Record<string, string> = {};
      let ok = true;
      for (let i = 0; i < segments.length && ok; i++) {
        if (segments[i].startsWith(":")) {
          try {
            params[segments[i].slice(1)] = decodeURIComponent(parts[i]);
          } catch {
            ok = false;
          }
        } else if (segments[i] !== parts[i]) ok = false;
      }
      if (!ok) continue;
      if (route.method === method) return { route, params };
      methodMismatch = true;
    }
    return { methodMismatch };
  }
}

export class Engine {
  constructor(
    private store: TenantStore,
    private ports: DomainPorts,
    private log: Logger,
    private opts: { strictResponses: boolean },
  ) {
    // After every write: schedule the next time-driven transition for this workspace and
    // hand new audit entries / notifications to the fan-out job (webhooks, Slack, email).
    store.onBeforeCommit((draft, effects, change) => {
      scheduleAdvance(draft, effects);
      if (change.newAuditLogs.length || change.newNotifications.length)
        effects.enqueue({
          kind: "events.fanout",
          payload: { events: change.newAuditLogs, notifications: change.newNotifications },
        });
    });
  }

  authorize(route: RouteDef, principal: Principal) {
    if (route.auth === "public" || route.auth === "authenticated" || route.auth === "member")
      return;
    if (!can(principal.role, route.auth))
      throw new HttpError(403, `Your role (${principal.role}) can't do this`);
  }

  async run(route: RouteDef, principal: Principal, req: RouteRequest): Promise<unknown> {
    this.authorize(route, principal);
    const now = req.now ?? Date.now();
    const ctxFor = (db: TenantState, prepared?: unknown): Ctx => ({
      db,
      user: principal.user,
      orgId: principal.orgId,
      role: principal.role,
      params: req.params,
      query: req.query,
      body: req.body,
      now,
      ip: req.ip,
      workspaces: principal.workspaces,
      ports: this.ports,
      prepared,
    });

    let result: unknown;
    if (route.method === "GET") {
      const snapshot = await this.store.read(principal.orgId);
      const prepared = route.prepare ? await route.prepare(ctxFor(snapshot)) : undefined;
      result = await route.handler(ctxFor(snapshot, prepared));
    } else {
      const snapshot = await this.store.read(principal.orgId);
      // A suspended workspace stays readable (and exportable) but cannot change anything.
      if (this.store.suspension(principal.orgId) !== null)
        throw new HttpError(
          403,
          "This workspace is suspended and read-only. Contact support to restore it.",
          undefined,
          "workspace_suspended",
        );
      const prepared = route.prepare ? await route.prepare(ctxFor(snapshot)) : undefined;
      result = await this.store.write(principal.orgId, (draft) => {
        bindRequest(draft, { ip: req.ip });
        // Bring time-driven state up to date first so the handler never acts on stale statuses.
        advance(draft, now);
        return route.handler(ctxFor(draft, prepared));
      });
    }
    return this.checkResponse(route, result);
  }

  /** The response schema is the contract with the web app: a drift is a bug, never silently shipped in tests. */
  checkResponse(route: RouteDef, result: unknown): unknown {
    const check = route.response.safeParse(result);
    if (check.success) return result;
    const details = z.flattenError(check.error);
    this.log.error(
      { route: `${route.method} ${route.path}`, details },
      "response does not match its schema",
    );
    if (this.opts.strictResponses)
      throw new HttpError(
        500,
        `Response for ${route.method} ${route.path} does not match its schema`,
        details,
      );
    return result;
  }
}

export function scheduleAdvance(draft: TenantState, effects: Effects) {
  const due = nextDueAt(draft);
  if (due === null) return;
  const orgId = draft.organizations[0].id;
  effects.enqueue({
    kind: "tenant.advance",
    orgId,
    runAt: new Date(due),
    dedupeKey: `tenant.advance:${orgId}`,
  });
}
