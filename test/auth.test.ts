/** Real authentication and account flows (demo mode off). */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, type Client, type Harness } from "./helpers";

let h: Harness;
let owner: Client;
let orgId: string;
const PASSWORD = "correct horse battery";

async function signUp(email: string, name = "Ada Lovelace", extra: Record<string, unknown> = {}) {
  const c = h.client();
  const res = await c.post("/signup", {
    name,
    email,
    method: "email",
    password: PASSWORD,
    ...extra,
  });
  return { c, res };
}

beforeAll(async () => {
  h = await createHarness({ DEMO_MODE: "false" });
  const { c, res } = await signUp("ada@example.com");
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  owner = c;
  const org = await owner.post("/orgs", {
    name: "Analytical Engines",
    kind: "team",
    useCase: "verify_prs",
  });
  expect(org.status, JSON.stringify(org.body)).toBe(200);
  orgId = org.body.id;
  // Seats: put the workspace on the Team plan (billing itself is covered elsewhere).
  await h.app.store.write(orgId, (db) => void (db.organizations[0].plan = "team"));
});
afterAll(() => h.close());

describe("sign-up and sign-in", () => {
  it("creates a workspace with safe defaults and an audit entry", async () => {
    const info = (await owner.get("/session")).body;
    expect(info).toMatchObject({ role: "owner", personas: [] });
    expect(info.workspace).toMatchObject({ id: orgId, slug: "analytical-engines" });
    const policy = (await owner.get("/policy")).body;
    expect(policy.protectedPaths).toContain(".github/workflows/**");
    expect(
      policy.approvalRules.find((r: { action: string }) => r.action === "deploy_production").mode,
    ).toBe("prohibited");
    const audit = (await owner.get("/audit-logs")).body;
    expect(audit.at(-1).action).toBe("workspace.created");
    expect((await owner.get("/overview")).status).toBe(200);
    expect((await owner.get("/billing")).body.paymentMethod).toBeNull();
  });

  it("sets an HttpOnly session cookie that is not the user id", async () => {
    const res = await h.server.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ email: "ADA@example.com", password: PASSWORD }),
    });
    expect(res.statusCode).toBe(200);
    const session = res.cookies.find((c) => c.name === "fp_session")!;
    expect(session.httpOnly).toBe(true);
    expect(session.sameSite).toBe("Lax");
    expect(session.value.length).toBeGreaterThan(30);
    const stored = await h.app.db.query(`SELECT token_hash FROM auth_sessions`);
    expect(
      stored.rows.some((r) => (r as { token_hash: string }).token_hash === session.value),
    ).toBe(false);
  });

  it("rejects wrong credentials without revealing whether the account exists", async () => {
    const c = h.client();
    const wrong = await c.post("/auth/login", {
      email: "ada@example.com",
      password: "nope nope nope",
    });
    const unknown = await c.post("/auth/login", {
      email: "nobody@example.com",
      password: "nope nope nope",
    });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body.error).toBe(unknown.body.error);
  });

  it("refuses duplicate emails, weak passwords, passwordless sign-up and demo sign-in", async () => {
    expect((await signUp("Ada@Example.com")).res.status).toBe(409);
    expect(
      (
        await h.client().post("/signup", {
          name: "Bob",
          email: "bob@example.com",
          method: "email",
          password: "short",
        })
      ).status,
    ).toBe(422);
    expect(
      (await h.client().post("/signup", { name: "Bob", email: "bob@example.com", method: "email" }))
        .status,
    ).toBe(422);
    expect((await h.client().post("/session", { userId: "u_maya" })).status).toBe(403);
    expect((await h.client().get("/session/personas")).body).toEqual([]);
    expect((await h.client().post("/demo/reset")).status).toBe(404);
  });

  it("logs out, and a signed-in user without a workspace is sent to onboarding", async () => {
    const { c } = await signUp("grace@example.com", "Grace Hopper");
    expect((await c.get("/session/status")).body).toEqual({
      signedIn: true,
      hasWorkspace: false,
      name: "Grace Hopper",
    });
    expect((await c.get("/overview")).status).toBe(403);
    expect((await c.post("/auth/logout")).status).toBe(200);
    expect((await c.get("/session/status")).body.signedIn).toBe(false);
  });

  it("resets a password with a single-use emailed link and signs out other sessions", async () => {
    const { c } = await signUp("reset@example.com", "Reset Me");
    expect(
      (await h.client().post("/auth/password/forgot", { email: "reset@example.com" })).status,
    ).toBe(200);
    expect(
      (await h.client().post("/auth/password/forgot", { email: "ghost@example.com" })).status,
    ).toBe(200);
    await h.app.worker.drain();
    const mail = h.app.mailer.outbox.find((m) => m.to === "reset@example.com")!;
    expect(h.app.mailer.outbox.some((m) => m.to === "ghost@example.com")).toBe(false);
    const token = /token=([\w-]+)/.exec(mail.text)![1];
    const input = { token, password: "a brand new passphrase" };
    expect((await h.client().post("/auth/password/reset", input)).status).toBe(200);
    expect((await h.client().post("/auth/password/reset", input)).status).toBe(400);
    expect((await c.get("/me")).status).toBe(401);
    expect(
      (
        await h
          .client()
          .post("/auth/login", { email: "reset@example.com", password: "a brand new passphrase" })
      ).status,
    ).toBe(200);
  });
});

describe("members and invitations", () => {
  it("invites by email; the invitee joins with the invited role and nobody else can use the link", async () => {
    const inv = await owner.post("/members/invite", { email: "linus@example.com", role: "member" });
    expect(inv.status, JSON.stringify(inv.body)).toBe(200);
    expect(
      (await owner.post("/members/invite", { email: "Linus@example.com", role: "member" })).status,
    ).toBe(409);
    await h.app.worker.drain();
    const mail = h.app.mailer.outbox.find((m) => m.to === "linus@example.com")!;
    const token = /invitation=([\w-]+)/.exec(mail.text)![1];
    expect((await h.client().get(`/invitations/lookup?token=${token}`)).body).toEqual({
      workspace: "Analytical Engines",
      email: "linus@example.com",
      role: "member",
    });
    const { c: stranger } = await signUp("mallory@example.com", "Mallory");
    expect((await stranger.post("/invitations/accept", { token })).status).toBe(403);

    const { c: linus, res } = await signUp("linus@example.com", "Linus", {
      invitationToken: token,
    });
    expect(res.status).toBe(200);
    expect((await linus.get("/session")).body).toMatchObject({
      role: "member",
      workspace: { id: orgId },
    });
    expect(
      (await owner.get("/members")).body.members.map((m: { email: string }) => m.email),
    ).toContain("linus@example.com");
    expect((await h.client().get(`/invitations/lookup?token=${token}`)).status).toBe(404);

    // Role rules: members can't manage members; the last owner can't be demoted; removal revokes access at once.
    const linusId = (await linus.get("/me")).body.user.id;
    const adaId = (await owner.get("/me")).body.user.id;
    expect((await linus.post(`/members/${adaId}/role`, { role: "viewer" })).status).toBe(403);
    expect((await owner.post(`/members/${adaId}/role`, { role: "admin" })).status).toBe(409);
    expect((await owner.post(`/members/${linusId}/remove`)).status).toBe(200);
    expect((await linus.get("/overview")).status).toBe(403);
    // History still names the former member.
    const joined = (await owner.get("/audit-logs")).body.find(
      (a: { action: string }) => a.action === "member.joined",
    );
    expect(joined.actorResolved.name).toBe("Linus");
  });
});

describe("API keys", () => {
  it("authenticates with a key shown once, scoped to its workspace, and dies on revoke", async () => {
    const created = await owner.post("/api-keys", { name: "CI", scopes: ["tasks:write"] });
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    const { key, secret } = created.body;
    expect(secret).toMatch(/^fp_live_[A-Za-z0-9]{24,}$/);
    expect(secret.startsWith(key.prefix)).toBe(true);
    const rows = await h.app.db.query<{ token_hash: string }>(
      `SELECT token_hash FROM api_key_secrets`,
    );
    expect(JSON.stringify(rows.rows)).not.toContain(secret.slice(12));
    expect(JSON.stringify((await owner.get("/api-keys")).body)).not.toContain(secret.slice(12));

    const api = h.client();
    api.bearer = secret;
    expect((await api.get("/session")).body.workspace.id).toBe(orgId);
    expect((await api.post("/projects", { name: "From CI", description: "" })).status).toBe(200);
    const bad = h.client();
    bad.bearer = "fp_live_" + "a".repeat(32);
    expect((await bad.get("/session")).status).toBe(401);

    expect((await owner.post(`/api-keys/${key.id}/revoke`)).status).toBe(200);
    expect((await api.get("/session")).status).toBe(401);
  });
});

describe("request hardening", () => {
  it("blocks cross-site writes and non-JSON bodies on cookie sessions", async () => {
    const evil = await owner.post(
      "/projects",
      { name: "x", description: "" },
      { origin: "https://evil.example" },
    );
    expect(evil.status).toBe(403);
    expect(evil.body.code).toBe("csrf");
    const ok = await owner.post(
      "/workspace",
      { name: "Analytical Engines" },
      { origin: "http://localhost:3000" },
    );
    expect(ok.status).toBe(200);
    const form = await h.server.inject({
      method: "POST",
      url: "/api/v1/workspace",
      headers: { "content-type": "text/plain", cookie: `fp_session=${owner.cookies.fp_session}` },
      payload: '{"name":"Hijacked"}',
    });
    expect(form.statusCode).toBe(415);
  });

  it("replays the first response for a repeated Idempotency-Key", async () => {
    const input = { name: "Created once", description: "" };
    const first = await owner.post("/projects", input, { "idempotency-key": "k-1" });
    const again = await owner.post("/projects", input, { "idempotency-key": "k-1" });
    expect(again.body.id).toBe(first.body.id);
    const names = (await owner.get("/projects")).body.filter(
      (p: { name: string }) => p.name === "Created once",
    );
    expect(names).toHaveLength(1);
    const reused = await owner.post(
      "/projects",
      { name: "Different", description: "" },
      { "idempotency-key": "k-1" },
    );
    expect(reused.status).toBe(422);
  });

  it("refuses plan changes when billing is not configured", async () => {
    expect(
      (await owner.post("/billing/plan", { plan: "business", billingCycle: "monthly" })).status,
    ).toBe(409);
  });

  it("rate-limits credential endpoints per client", async () => {
    const strict = await createHarness({ DEMO_MODE: "false", AUTH_RATE_LIMIT_PER_MINUTE: "3" });
    try {
      const c = strict.client();
      const statuses = [];
      for (let i = 0; i < 5; i++)
        statuses.push((await c.post("/auth/login", { email: "a@b.co", password: "x" })).status);
      expect(statuses.slice(0, 3)).toEqual([401, 401, 401]);
      expect(statuses[4]).toBe(429);
    } finally {
      await strict.close();
    }
  });

  it("exposes health, metrics and an OpenAPI document", async () => {
    expect((await h.server.inject({ url: "/readyz" })).statusCode).toBe(200);
    expect((await h.server.inject({ url: "/metrics" })).body).toContain("fp_http_requests_total");
    const doc = (await h.client().get("/openapi.json")).body;
    expect(doc.openapi).toBe("3.1.0");
    expect(Object.keys(doc.paths).length).toBeGreaterThan(85);
    expect(doc.paths["/api/v1/tasks"].post.requestBody).toBeTruthy();
  });
});
