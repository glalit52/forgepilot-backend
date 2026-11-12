/**
 * HTTP layer. Translates requests into route-table calls and owns the
 * cross-cutting concerns: authentication (session cookie or API key), CSRF,
 * rate limits, idempotency keys, the error envelope, request ids, metrics,
 * live updates (SSE) and inbound webhooks.
 */
import { createHash, randomUUID } from "node:crypto";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import Fastify, {
  LogController,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from "fastify";
import type { App } from "../app";
import { verifyGithubSignature } from "../connectors/github";
import { ConnectorError } from "../connectors/http";
import { SESSION_COOKIE, WORKSPACE_COOKIE } from "../contract/domain/permissions";
import type { User } from "../contract/schemas";
import type { RouteDef, WorkspaceMembership } from "../domain/context";
import { RouteTable } from "../domain/engine";
import { adminRoutes } from "../identity/adminRoutes";
import { identityRoutes, type GlobalCtx, type GlobalRouteDef } from "../identity/routes";
import { randomToken, safeEqual } from "../platform/crypto";
import { HttpError } from "../platform/errors";
import { RateLimiter } from "../platform/rateLimit";
import { buildOpenApi } from "./openapi";

const OAUTH_STATE_COOKIE = "fp_oauth_state";
const VERSION = "0.1.0";

interface Caller {
  user: User;
  workspaces: WorkspaceMembership[];
  /** Set when the request authenticated with an API key: pinned to one workspace and role. */
  apiKey?: { orgId: string; role: WorkspaceMembership["role"]; keyId: string };
  sessionToken?: string;
}

declare module "fastify" {
  interface FastifyRequest {
    rawBody?: Buffer;
    routeLabel?: string;
  }
}

export async function buildServer(app: App): Promise<FastifyInstance> {
  const { config } = app;
  const server = Fastify({
    loggerInstance: app.log,
    logController: new LogController({ disableRequestLogging: true }),
    trustProxy: true,
    bodyLimit: 2 * 1024 * 1024,
    genReqId: (req) => {
      const given = req.headers["x-request-id"];
      return typeof given === "string" && /^[\w.-]{8,128}$/.test(given) ? given : randomUUID();
    },
  });
  const limiter = new RateLimiter();
  const accountRoutes = [...identityRoutes, ...adminRoutes];
  const globalTable = new RouteTable(accountRoutes as unknown as RouteDef[]);
  const allowedOrigins = new Set([new URL(config.appUrl).origin, ...config.corsOrigins]);

  await server.register(cookie);
  await server.register(cors, {
    origin: [...allowedOrigins],
    credentials: true,
    methods: ["GET", "POST"],
    allowedHeaders: ["Content-Type", "Authorization", "Idempotency-Key", "X-Request-Id"],
    maxAge: 600,
  });

  // JSON is the only accepted body type; anything else is answered with 415.
  server.removeAllContentTypeParsers();
  // Keep the exact bytes: webhook signatures are computed over the raw body.
  server.addContentTypeParser("application/json", { parseAs: "buffer" }, (req, body, done) => {
    req.rawBody = body as Buffer;
    if (!(body as Buffer).length) return done(null, {});
    try {
      done(null, JSON.parse((body as Buffer).toString("utf8")));
    } catch {
      done(new HttpError(400, "Body must be JSON"), undefined);
    }
  });

  server.addHook("onRequest", async (req, reply) => {
    reply.header("X-Request-Id", req.id);
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Cache-Control", "no-store");
    reply.header("Referrer-Policy", "no-referrer");
  });
  server.addHook("onResponse", async (req, reply) => {
    const route = req.routeLabel ?? "unmatched";
    app.metrics.requests.inc({ method: req.method, route, status: reply.statusCode });
    app.metrics.requestDuration.observe({ route }, reply.elapsedTime / 1000);
    req.log[reply.statusCode >= 500 ? "error" : "info"](
      { method: req.method, route, status: reply.statusCode, ms: Math.round(reply.elapsedTime) },
      "request",
    );
  });

  server.setErrorHandler((err, req, reply) => {
    let status = 500;
    let message = "Something went wrong on our side";
    let details: unknown;
    let code = "internal_error";
    if (err instanceof HttpError) ({ status, message, details, code } = err);
    else if (err instanceof ConnectorError) {
      // An upstream provider failed: say which one, never leak its response body.
      status = err.transient ? 503 : 502;
      message = `${err.provider} is not responding as expected. Try again shortly.`;
      code = "upstream_error";
      req.log.warn({ err, body: err.body }, "connector error");
    } else if (
      (err as { statusCode?: number }).statusCode &&
      (err as { statusCode: number }).statusCode < 500
    ) {
      status = (err as { statusCode: number }).statusCode;
      message =
        status === 413
          ? "Request body is too large"
          : status === 415
            ? "Send JSON (Content-Type: application/json)"
            : (err as Error).message;
      code =
        status === 413
          ? "payload_too_large"
          : status === 415
            ? "unsupported_media_type"
            : "bad_request";
    } else req.log.error({ err }, "unhandled error");
    void reply.status(status).send({
      error: message,
      ...(details !== undefined ? { details } : {}),
      code,
      requestId: req.id,
    });
  });
  server.setNotFoundHandler((req, reply) =>
    reply.status(404).send({
      error: `No route for ${req.method} ${req.url.split("?")[0]}`,
      code: "not_found",
      requestId: req.id,
    }),
  );

  // ---------------------------------------------------------------- helpers
  const cookieOpts = (maxAgeSec?: number) => ({
    path: "/",
    sameSite: "lax" as const,
    secure: config.cookie.secure,
    domain: config.cookie.domain,
    ...(maxAgeSec !== undefined ? { maxAge: maxAgeSec } : {}),
  });
  const setSessionCookie = (reply: FastifyReply, token: string) =>
    // HttpOnly: page scripts can't read the session, which is what makes XSS non-fatal.
    reply.setCookie(SESSION_COOKIE, token, {
      ...cookieOpts(config.cookie.ttlDays * 86_400),
      httpOnly: true,
    });
  const setWorkspaceCookie = (reply: FastifyReply, orgId: string) =>
    reply.setCookie(WORKSPACE_COOKIE, orgId, cookieOpts(config.cookie.ttlDays * 86_400));
  const clearCookies = (reply: FastifyReply) => {
    reply.clearCookie(SESSION_COOKIE, cookieOpts());
    reply.clearCookie(WORKSPACE_COOKIE, cookieOpts());
  };

  async function authenticate(req: FastifyRequest): Promise<Caller | null> {
    const header = req.headers.authorization;
    if (header?.startsWith("Bearer ")) {
      const key = await app.identity.resolveApiKey(header.slice(7).trim());
      if (!key) throw new HttpError(401, "Invalid API key");
      const workspaces = (await app.identity.membershipsOf(key.user.id)).filter(
        (w) => w.organization.id === key.orgId,
      );
      return {
        user: key.user,
        workspaces,
        apiKey: { orgId: key.orgId, role: key.role, keyId: key.keyId },
      };
    }
    const token = req.cookies[SESSION_COOKIE];
    const session = await app.identity.resolveSession(token);
    if (!session) return null;
    return {
      user: session.user,
      workspaces: await app.identity.membershipsOf(session.user.id),
      sessionToken: token,
    };
  }

  /**
   * CSRF defence for cookie-authenticated writes: the session cookie is SameSite=Lax,
   * bodies must be JSON (not sendable by a plain cross-site form), and when the browser
   * sends an Origin it must be the web app's. API-key requests carry no ambient credential.
   */
  function assertSameSite(req: FastifyRequest) {
    if (req.method !== "POST" || req.headers.authorization) return;
    const type = req.headers["content-type"] ?? "";
    if (req.rawBody?.length && !type.startsWith("application/json"))
      throw new HttpError(
        415,
        "Send JSON (Content-Type: application/json)",
        undefined,
        "unsupported_media_type",
      );
    const origin = req.headers.origin;
    if (origin && !allowedOrigins.has(origin) && origin !== `${req.protocol}://${req.host}`)
      throw new HttpError(403, "Cross-site request blocked", undefined, "csrf");
  }

  function rateLimit(req: FastifyRequest, reply: FastifyReply, bucket: string, limit: number) {
    const r = limiter.take(`${bucket}:${req.ip}`, limit);
    reply.header("RateLimit-Limit", limit);
    reply.header("RateLimit-Remaining", r.remaining);
    if (!r.ok) {
      reply.header("Retry-After", Math.ceil(r.resetMs / 1000));
      throw new HttpError(429, "Too many requests. Slow down and try again shortly.");
    }
  }

  function activeMembership(req: FastifyRequest, caller: Caller): WorkspaceMembership | undefined {
    if (caller.apiKey) {
      const m = caller.workspaces[0];
      return m ? { organization: m.organization, role: caller.apiKey.role } : undefined;
    }
    const wanted = req.cookies[WORKSPACE_COOKIE];
    return caller.workspaces.find((w) => w.organization.id === wanted) ?? caller.workspaces[0];
  }

  /** Replays the stored response when the same Idempotency-Key is retried (PRD §14.1). */
  async function idempotent(
    req: FastifyRequest,
    scope: string,
    run: () => Promise<unknown>,
  ): Promise<unknown> {
    const key = req.headers["idempotency-key"];
    if (typeof key !== "string" || !key) return run();
    if (key.length > 200) throw new HttpError(400, "Idempotency-Key is too long");
    const hash = createHash("sha256")
      .update(`${req.method} ${req.url}\n`)
      .update(req.rawBody ?? "")
      .digest("hex");
    const claimed = await app.db.query(
      `INSERT INTO idempotency_keys (scope, key, request_hash) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
      [scope, key, hash],
    );
    if (!claimed.rowCount) {
      const { rows } = await app.db.query<{
        request_hash: string;
        status: number | null;
        response: unknown;
      }>(
        `SELECT request_hash, status, response FROM idempotency_keys WHERE scope = $1 AND key = $2`,
        [scope, key],
      );
      const prior = rows[0];
      if (prior && prior.request_hash !== hash)
        throw new HttpError(422, "This Idempotency-Key was already used for a different request");
      if (prior?.status) return prior.response;
      throw new HttpError(409, "A request with this Idempotency-Key is still in progress");
    }
    try {
      const result = await run();
      await app.db.query(
        `UPDATE idempotency_keys SET status = 200, response = $3::jsonb WHERE scope = $1 AND key = $2`,
        [scope, key, JSON.stringify(result ?? null)],
      );
      return result;
    } catch (err) {
      // Failed requests may be retried with the same key.
      await app.db.query(`DELETE FROM idempotency_keys WHERE scope = $1 AND key = $2`, [
        scope,
        key,
      ]);
      throw err;
    }
  }

  // ---------------------------------------------------------------- operations endpoints
  server.get("/healthz", async (req) => {
    req.routeLabel = "/healthz";
    return { ok: true };
  });
  server.get("/readyz", async (req, reply) => {
    req.routeLabel = "/readyz";
    try {
      await app.db.query("SELECT 1");
      return { ok: true };
    } catch {
      return reply.status(503).send({ ok: false });
    }
  });
  server.get("/metrics", async (req, reply) => {
    req.routeLabel = "/metrics";
    return reply.type("text/plain; version=0.0.4").send(app.metrics.render());
  });

  await server.register(
    async (api) => {
      api.get("/openapi.json", async (req) => {
        req.routeLabel = "/openapi.json";
        return buildOpenApi([...identityRoutes, ...app.tenantRoutes.routes], {
          prefix: config.apiPrefix,
          version: VERSION,
        });
      });

      // ------------------------------------------------------------ live updates (SSE)
      api.get("/events", async (req, reply) => {
        req.routeLabel = "/events";
        const caller = await authenticate(req);
        if (!caller) throw new HttpError(401, "Not signed in");
        const orgId = activeMembership(req, caller)?.organization.id;
        if (!orgId) throw new HttpError(403, "No workspace — finish onboarding first");
        await app.store.read(orgId);
        reply.hijack();
        const origin = req.headers.origin;
        reply.raw.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache, no-transform",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
          ...(origin && allowedOrigins.has(origin)
            ? { "Access-Control-Allow-Origin": origin, "Access-Control-Allow-Credentials": "true" }
            : {}),
        });
        const send = (event: string, data: unknown) =>
          reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        app.metrics.sseClients.value++;
        send("ready", { at: Date.now() });
        const unsubscribe = app.bus.subscribe((e) => {
          if (e.orgId !== orgId) return;
          send("change", { at: Date.now() });
          // Refresh the cached snapshot so ticks reflect writes made by other instances.
          void app.store.read(orgId).catch(() => undefined);
        });
        let beats = 0;
        // Events carry ids only; the client refetches through the authorised API.
        const timer = setInterval(() => {
          const state = app.store.peek(orgId);
          if (state) {
            const sessions = state.sessions
              .filter((s) => s.status === "running" || s.status === "waiting")
              .map((s) => s.id);
            const runs = state.testRuns.filter((r) => r.status === "running").map((r) => r.id);
            if (sessions.length || runs.length) send("tick", { sessions, runs });
          }
          if (++beats % 15 === 0) send("ping", { at: Date.now() });
        }, 1000);
        req.raw.on("close", () => {
          clearInterval(timer);
          unsubscribe();
          app.metrics.sseClients.value--;
        });
      });

      // ------------------------------------------------------------ sign in with GitHub
      const callbackUrl = `${config.publicApiUrl}/auth/github/callback`;
      api.get("/auth/github/start", async (req, reply) => {
        req.routeLabel = "/auth/github/start";
        if (!app.github.oauthConfigured)
          throw new HttpError(503, "GitHub sign-in is not configured");
        rateLimit(req, reply, "auth", config.rateLimit.authPerMinute);
        const state = randomToken(24);
        reply.setCookie(OAUTH_STATE_COOKIE, state, { ...cookieOpts(600), httpOnly: true });
        return reply.redirect(app.github.authorizeUrl(state, callbackUrl));
      });
      api.get("/auth/github/callback", async (req, reply) => {
        req.routeLabel = "/auth/github/callback";
        rateLimit(req, reply, "auth", config.rateLimit.authPerMinute);
        const q = req.query as { code?: string; state?: string };
        const expected = req.cookies[OAUTH_STATE_COOKIE];
        reply.clearCookie(OAUTH_STATE_COOKIE, cookieOpts());
        // The state cookie binds the callback to the browser that started the flow (login CSRF).
        if (!q.code || !q.state || !expected || !safeEqual(q.state, expected))
          return reply.redirect(`${config.appUrl}/login?error=github_state`);
        try {
          const gh = await app.github.oauthUser(q.code, callbackUrl);
          const user = await app.identity.upsertOAuthUser({
            provider: "github",
            providerUserId: gh.id,
            email: gh.email,
            name: gh.name,
            login: gh.login,
          });
          const workspaces = await app.identity.membershipsOf(user.id);
          setSessionCookie(
            reply,
            await app.identity.createSession(user.id, {
              ip: req.ip,
              userAgent: req.headers["user-agent"] ?? null,
            }),
          );
          setWorkspaceCookie(reply, workspaces[0]?.organization.id ?? "");
          return reply.redirect(`${config.appUrl}${workspaces.length ? "/app" : "/onboarding"}`);
        } catch (err) {
          req.log.warn({ err }, "github sign-in failed");
          return reply.redirect(`${config.appUrl}/login?error=github`);
        }
      });

      // ------------------------------------------------------------ inbound webhooks
      api.post("/webhooks/github", async (req, reply) => {
        req.routeLabel = "/webhooks/github";
        const secret = config.github.webhookSecret;
        if (!secret) throw new HttpError(503, "GitHub webhooks are not configured");
        const signature = req.headers["x-hub-signature-256"];
        if (
          !req.rawBody ||
          !verifyGithubSignature(
            secret,
            req.rawBody,
            typeof signature === "string" ? signature : undefined,
          )
        ) {
          app.metrics.webhooks.inc({ provider: "github", result: "bad_signature" });
          throw new HttpError(401, "Invalid signature");
        }
        const delivery = req.headers["x-github-delivery"];
        const event = req.headers["x-github-event"];
        if (typeof delivery !== "string" || typeof event !== "string")
          throw new HttpError(400, "Missing delivery headers");
        const fresh = await app.githubEvents.accept(delivery, event, req.body);
        app.metrics.webhooks.inc({ provider: "github", result: fresh ? "accepted" : "duplicate" });
        return reply.status(202).send({ ok: true, duplicate: !fresh });
      });
      api.post("/webhooks/stripe", async (req, reply) => {
        req.routeLabel = "/webhooks/stripe";
        const signature = req.headers["stripe-signature"];
        const event = app.billing.parseWebhook(
          req.rawBody ?? Buffer.alloc(0),
          typeof signature === "string" ? signature : undefined,
        );
        const fresh = await app.stripeEvents.accept(event);
        app.metrics.webhooks.inc({ provider: "stripe", result: fresh ? "accepted" : "duplicate" });
        return reply.status(202).send({ ok: true, duplicate: !fresh });
      });

      // ------------------------------------------------------------ route tables
      api.route({
        method: ["GET", "POST"],
        url: "/*",
        handler: async (req, reply) => {
          const path = "/" + (req.params as { "*": string })["*"];
          const query = new URLSearchParams(req.url.split("?")[1] ?? "");
          const now = Date.now();
          rateLimit(req, reply, "api", config.rateLimit.perMinute);

          const global = globalTable.match(req.method, path);
          if ("route" in global) {
            const route = global.route as unknown as GlobalRouteDef;
            req.routeLabel = route.path;
            if (route.sensitive) rateLimit(req, reply, "auth", config.rateLimit.authPerMinute);
            assertSameSite(req);
            const caller = await authenticate(req);
            if (route.auth !== "public" && !caller) throw new HttpError(401, "Not signed in");
            // The back-office answers 404 to everyone else, so its existence isn't advertised.
            if (
              route.auth === "staff" &&
              (caller!.apiKey || !(await app.identity.isStaff(caller!.user.id)))
            )
              throw new HttpError(404, `No route for ${req.method} ${path}`);
            const ctx: GlobalCtx = {
              app,
              user: caller?.user ?? null,
              workspaces: caller?.workspaces ?? [],
              activeOrgId: caller ? (activeMembership(req, caller)?.organization.id ?? null) : null,
              params: global.params,
              query,
              body: req.method === "GET" ? undefined : req.body,
              now,
              ip: req.ip,
              userAgent: req.headers["user-agent"] ?? null,
              session: {
                token: caller?.sessionToken,
                start: async (userId, orgId) => {
                  setSessionCookie(
                    reply,
                    await app.identity.createSession(userId, {
                      ip: req.ip,
                      userAgent: req.headers["user-agent"] ?? null,
                    }),
                  );
                  setWorkspaceCookie(reply, orgId);
                },
                selectWorkspace: (orgId) => void setWorkspaceCookie(reply, orgId),
                end: async () => {
                  await app.identity.destroySession(req.cookies[SESSION_COOKIE]);
                  clearCookies(reply);
                },
              },
            };
            const result = await route.handler(ctx);
            const check = route.response.safeParse(result);
            if (!check.success) {
              req.log.error(
                { route: route.path, issues: check.error.issues },
                "response does not match its schema",
              );
              if (!config.production)
                throw new HttpError(
                  500,
                  `Response for ${route.method} ${route.path} does not match its schema`,
                );
            }
            return result;
          }

          const match = app.tenantRoutes.match(req.method, path);
          if (!("route" in match)) {
            if (global.methodMismatch || match.methodMismatch)
              throw new HttpError(405, `Method ${req.method} is not allowed for ${path}`);
            throw new HttpError(404, `No route for ${req.method} ${path}`);
          }
          const { route, params } = match;
          req.routeLabel = route.path;
          assertSameSite(req);
          if (route.auth === "public")
            return app.engine.checkResponse(
              route,
              await route.handler({ params, query, body: req.body, now } as never),
            );
          const caller = await authenticate(req);
          if (!caller) throw new HttpError(401, "Not signed in");
          const membership = activeMembership(req, caller);
          if (!membership) throw new HttpError(403, "No workspace — finish onboarding first");
          const principal = {
            user: caller.user,
            orgId: membership.organization.id,
            role: membership.role,
            workspaces: caller.workspaces,
          };
          const run = () =>
            app.engine.run(route, principal, {
              params,
              query,
              body: req.method === "GET" ? undefined : req.body,
              ip: req.ip,
              now,
            });
          return req.method === "POST"
            ? idempotent(req, `${principal.orgId}:${caller.user.id}`, run)
            : run();
        },
      });
    },
    { prefix: config.apiPrefix },
  );

  return server as unknown as FastifyInstance;
}
