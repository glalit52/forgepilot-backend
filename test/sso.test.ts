/** Single sign-on through a customer's identity provider, against a fake OpenID Connect provider. */
import { exportJWK, generateKeyPair, SignJWT, type CryptoKey } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, type Client, type Harness } from "./helpers";

const ISSUER = "https://idp.bigcorp.test";
const CLIENT_ID = "fp-client";
let h: Harness;
let owner: Client;
let orgId: string;
let signingKey: CryptoKey;
let otherKey: CryptoKey;
let jwks: { keys: object[] };
/** What the fake provider will put in the next ID token. */
let nextToken: { claims: Record<string, unknown>; key?: CryptoKey } = { claims: {} };
const tokenRequests: URLSearchParams[] = [];

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const fakeFetch: typeof fetch = async (input, init) => {
  const url = new URL(String(input));
  if (url.origin !== ISSUER) return json({ error: "unexpected host" }, 500);
  if (url.pathname === "/.well-known/openid-configuration")
    return json({
      issuer: ISSUER,
      authorization_endpoint: `${ISSUER}/authorize`,
      token_endpoint: `${ISSUER}/token`,
      jwks_uri: `${ISSUER}/keys`,
    });
  if (url.pathname === "/keys") return json(jwks);
  if (url.pathname === "/token") {
    tokenRequests.push(new URLSearchParams(String(init?.body)));
    const id_token = await new SignJWT(nextToken.claims)
      .setProtectedHeader({ alg: "RS256", kid: "k1" })
      .setIssuer(ISSUER)
      .setAudience(CLIENT_ID)
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(nextToken.key ?? signingKey);
    return json({ id_token, token_type: "Bearer" });
  }
  return json({}, 404);
};

const config = {
  issuer: ISSUER,
  clientId: CLIENT_ID,
  clientSecret: "s3cret-value",
  domain: "bigcorp.test",
};
const connect = (c: Client, credentials: Record<string, string> = config) =>
  c.post("/integrations/okta/connect", { account: "bigcorp", credentials });

/** Runs the browser part of a sign-in and returns where it ended up. */
async function signIn(
  email: string,
  claims: (nonce: string) => Record<string, unknown>,
  tamper?: (c: Client) => void,
) {
  const c = h.client();
  const start = await c.get(`/auth/sso/start?email=${encodeURIComponent(email)}`);
  const location = String(start.headers.location);
  if (!location.startsWith(ISSUER)) return { c, location, authorize: null };
  const authorize = new URL(location);
  const flow = JSON.parse(decodeURIComponent(c.cookies.fp_sso));
  nextToken = { ...nextToken, claims: claims(flow.nonce) };
  tamper?.(c);
  const done = await c.get(
    `/auth/sso/callback?code=abc&state=${authorize.searchParams.get("state")}`,
  );
  return { c, location: String(done.headers.location), authorize };
}

beforeAll(async () => {
  const a = await generateKeyPair("RS256");
  const b = await generateKeyPair("RS256");
  signingKey = a.privateKey;
  otherKey = b.privateKey;
  jwks = { keys: [{ ...(await exportJWK(a.publicKey)), kid: "k1", alg: "RS256", use: "sig" }] };
  h = await createHarness(
    { DEMO_MODE: "false" },
    {
      fetch: fakeFetch,
      resolveHost: async (host) => (host === "idp.bigcorp.test" ? ["93.184.216.34"] : ["10.0.0.1"]),
    },
  );
  owner = h.client();
  await owner.post("/signup", {
    name: "Ada Lovelace",
    email: "ada@bigcorp.test",
    method: "email",
    password: "correct horse battery",
  });
  orgId = (await owner.post("/orgs", { name: "BigCorp", kind: "team", useCase: "verify_prs" })).body
    .id;
});
afterAll(() => h.close());

describe("single sign-on", () => {
  it("is an Enterprise feature and validates the provider settings", async () => {
    expect((await connect(owner)).status).toBe(402);
    await h.app.store.write(orgId, (db) => void (db.organizations[0].plan = "enterprise"));
    expect((await owner.post("/integrations/okta/connect", { account: "bigcorp" })).status).toBe(
      422,
    );
    expect((await connect(owner, { ...config, domain: "gmail.com" })).status).toBe(422);
    // Claiming a domain you don't have an address in is refused.
    expect((await connect(owner, { ...config, domain: "othercorp.test" })).status).toBe(422);
    // An issuer on a private address must never be called by the server.
    expect((await connect(owner, { ...config, issuer: "https://idp.internal.test" })).status).toBe(
      422,
    );

    const ok = await connect(owner);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.account).toBe("bigcorp.test (waiting for ForgePilot approval)");
    expect(JSON.stringify(ok.body)).not.toContain("s3cret-value");
  });

  it("does nothing until ForgePilot staff approve the domain", async () => {
    const before = await signIn("bob@bigcorp.test", () => ({}));
    expect(before.location).toBe("http://localhost:3000/login?error=sso_unavailable");
    const pending = await h.app.sso.listDomains();
    expect(pending[0]).toMatchObject({
      domain: "bigcorp.test",
      workspaceId: orgId,
      status: "pending",
      requestedBy: "ada@bigcorp.test",
    });
    await h.app.sso.decide("bigcorp.test", "approved");
    expect(
      (await owner.get("/integrations")).body.find(
        (i: { providerId: string }) => i.providerId === "okta",
      ).connection.account,
    ).toBe("bigcorp.test (active)");
    expect(
      (await owner.get("/audit-logs")).body.map((a: { action: string }) => a.action),
    ).toContain("sso.domain_approved");
  });

  it("signs a new colleague in, creates their account and adds them as a member", async () => {
    nextToken = { claims: {} };
    const { c, location, authorize } = await signIn("bob@bigcorp.test", (nonce) => ({
      nonce,
      email: "Bob@BigCorp.test",
      email_verified: true,
      name: "Bob Builder",
    }));
    expect(authorize!.searchParams.get("client_id")).toBe(CLIENT_ID);
    expect(authorize!.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorize!.searchParams.get("redirect_uri")).toBe(
      "http://localhost:8080/api/v1/auth/sso/callback",
    );
    expect(location).toBe("http://localhost:3000/app");
    // The code was exchanged with the PKCE verifier and the client secret, server to server.
    expect(tokenRequests.at(-1)!.get("code_verifier")!.length).toBeGreaterThan(40);
    expect(tokenRequests.at(-1)!.get("client_secret")).toBe("s3cret-value");
    const session = (await c.get("/session")).body;
    expect(session).toMatchObject({
      role: "member",
      workspace: { id: orgId },
      user: { name: "Bob Builder", email: "bob@bigcorp.test" },
    });
    expect(c.cookies.fp_sso).toBeUndefined();
    // Signing in again reuses the account.
    const again = await signIn("bob@bigcorp.test", (nonce) => ({
      nonce,
      email: "bob@bigcorp.test",
    }));
    expect((await again.c.get("/session")).body.user.id).toBe(session.user.id);
  });

  it("rejects forged, replayed and out-of-domain sign-ins", async () => {
    const good = (nonce: string) => ({ nonce, email: "carol@bigcorp.test", email_verified: true });
    // Signed by a key the provider does not publish.
    nextToken = { claims: {}, key: otherKey };
    expect((await signIn("carol@bigcorp.test", good)).location).toMatch(/error=sso_failed/);
    nextToken = { claims: {} };
    // A token minted for a different browser's sign-in.
    expect(
      (
        await signIn("carol@bigcorp.test", () => ({
          nonce: "someone-elses",
          email: "carol@bigcorp.test",
        }))
      ).location,
    ).toMatch(/error=sso_failed/);
    // The provider vouches for an address outside the approved domain.
    expect(
      (await signIn("carol@bigcorp.test", (nonce) => ({ nonce, email: "ceo@othercorp.test" })))
        .location,
    ).toMatch(/error=sso_wrong_domain/);
    expect(
      (
        await signIn("carol@bigcorp.test", (nonce) => ({
          nonce,
          email: "carol@bigcorp.test",
          email_verified: false,
        }))
      ).location,
    ).toMatch(/error=sso_wrong_domain/);
    // The state cookie is gone or belongs to another flow.
    expect(
      (await signIn("carol@bigcorp.test", good, (c) => delete c.cookies.fp_sso)).location,
    ).toMatch(/error=sso_failed/);
    expect(await h.app.identity.findByEmail("carol@bigcorp.test")).toBeNull();
  });

  it("does not hand over an existing account that isn't in the workspace, and stops when SSO is removed", async () => {
    await h.client().post("/signup", {
      name: "Eve",
      email: "eve@bigcorp.test",
      method: "email",
      password: "correct horse battery",
    });
    expect(
      (await signIn("eve@bigcorp.test", (nonce) => ({ nonce, email: "eve@bigcorp.test" })))
        .location,
    ).toMatch(/error=sso_not_member/);
    // Changing the settings needs a new approval.
    await connect(owner, { ...config, clientSecret: "rotated-secret" });
    expect((await signIn("bob@bigcorp.test", () => ({}))).location).toMatch(
      /error=sso_unavailable/,
    );
    await h.app.sso.decide("bigcorp.test", "approved");
    expect((await owner.post("/integrations/okta/disconnect")).status).toBe(200);
    expect(await h.app.sso.listDomains()).toEqual([]);
    expect((await signIn("bob@bigcorp.test", () => ({}))).location).toMatch(
      /error=sso_unavailable/,
    );
  });
});
