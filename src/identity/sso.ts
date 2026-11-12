/**
 * Single sign-on with a customer's own identity provider (Okta, Microsoft
 * Entra ID or any OpenID Connect provider).
 *
 * Safety rules
 *  - A workspace claims an email domain; the claim does nothing until ForgePilot
 *    staff approve it. Otherwise anyone could claim "bigcorp.com" and mint sign-ins
 *    for its addresses.
 *  - A sign-in is only accepted for an address in the approved domain, with a
 *    token signed by the provider's published keys, issued for this client, and
 *    carrying the nonce this browser started with.
 *  - An existing ForgePilot account is only signed in if it already belongs to
 *    that workspace. New addresses get an account and join as members.
 */
import { createHash } from "node:crypto";
import { createLocalJWKSet, jwtVerify, type JSONWebKeySet } from "jose";
import type { CredentialStore, Secret } from "../connectors/credentials";
import { requestJson, type FetchLike } from "../connectors/http";
import { assertPublicHttpsUrl } from "../connectors/outboundWebhooks";
import type { User } from "../contract/schemas";
import { randomToken } from "../platform/crypto";
import type { Database, Queryable } from "../platform/db";
import { HttpError } from "../platform/errors";
import { newId, toIso } from "../platform/ids";
import type { TenantStore } from "../tenancy/store";
import type { IdentityService } from "./service";

/** Mail providers anyone can get an address at: never claimable as a company domain. */
const PUBLIC_DOMAINS = new Set([
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "yahoo.com",
  "icloud.com",
  "me.com",
  "proton.me",
  "protonmail.com",
  "aol.com",
  "gmx.com",
  "mail.com",
]);

interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
}

export interface SsoFlowState {
  state: string;
  nonce: string;
  verifier: string;
  orgId: string;
  domain: string;
  providerId: string;
}

export const SSO_PROVIDERS = ["okta", "entra"];
export const domainOf = (email: string) => email.trim().toLowerCase().split("@")[1] ?? "";
const s256 = (v: string) => createHash("sha256").update(v).digest("base64url");

export class SsoService {
  private discoveryCache = new Map<string, { at: number; doc: Discovery }>();

  constructor(
    private deps: {
      db: Database;
      store: TenantStore;
      identity: IdentityService;
      credentials: CredentialStore;
      fetchImpl: FetchLike;
      resolveHost?: (host: string) => Promise<string[]>;
      callbackUrl: string;
    },
  ) {}

  private async publicUrl(value: string): Promise<string> {
    return (await assertPublicHttpsUrl(value, this.deps.resolveHost)).toString();
  }

  private async discover(issuer: string): Promise<Discovery> {
    const base = issuer.replace(/\/$/, "");
    const cached = this.discoveryCache.get(base);
    if (cached && Date.now() - cached.at < 10 * 60_000) return cached.doc;
    const doc = await requestJson<Discovery>(
      this.deps.fetchImpl,
      "sso",
      await this.publicUrl(`${base}/.well-known/openid-configuration`),
    );
    if (
      !doc.issuer ||
      doc.issuer.replace(/\/$/, "") !== base ||
      !doc.authorization_endpoint ||
      !doc.token_endpoint ||
      !doc.jwks_uri
    )
      throw new HttpError(422, "That issuer URL does not describe a valid OpenID Connect provider");
    // Every endpoint the server will call must itself be a public https address.
    await this.publicUrl(doc.token_endpoint);
    await this.publicUrl(doc.jwks_uri);
    this.discoveryCache.set(base, { at: Date.now(), doc });
    return doc;
  }

  /** Validates the settings an admin entered, before they are stored. */
  async verifyConfig(secret: Secret): Promise<{ account: string }> {
    for (const field of ["issuer", "clientId", "clientSecret", "domain"])
      if (!secret[field]) throw new HttpError(422, `Missing credential field "${field}"`);
    const domain = secret.domain.trim().toLowerCase();
    if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(domain))
      throw new HttpError(422, "Enter the email domain, like company.com");
    if (PUBLIC_DOMAINS.has(domain))
      throw new HttpError(422, "A public email provider can't be used for single sign-on");
    await this.discover(secret.issuer);
    return { account: `${domain} (waiting for ForgePilot approval)` };
  }

  /** Records the workspace's claim on its email domain; inactive until staff approve it. */
  async claimDomain(
    q: Queryable,
    input: { orgId: string; providerId: string; domain: string; requester: User },
  ) {
    const domain = input.domain.trim().toLowerCase();
    if (domainOf(input.requester.email) !== domain)
      throw new HttpError(422, `Set up single sign-on from an account with an @${domain} address`);
    const existing = await q.query<{ org_id: string }>(
      `SELECT org_id FROM sso_domains WHERE domain = $1`,
      [domain],
    );
    if (existing.rows[0] && existing.rows[0].org_id !== input.orgId)
      throw new HttpError(409, "That domain is already set up for another workspace");
    await q.query(`DELETE FROM sso_domains WHERE org_id = $1`, [input.orgId]);
    // Any change to the settings needs a fresh approval.
    await q.query(
      `INSERT INTO sso_domains (domain, org_id, provider_id, requested_by) VALUES ($1, $2, $3, $4)`,
      [domain, input.orgId, input.providerId, input.requester.id],
    );
  }

  async removeDomains(q: Queryable, orgId: string) {
    await q.query(`DELETE FROM sso_domains WHERE org_id = $1`, [orgId]);
  }

  private async approved(domain: string) {
    const { rows } = await this.deps.db.query<{ org_id: string; provider_id: string }>(
      `SELECT d.org_id, d.provider_id FROM sso_domains d JOIN organizations o ON o.id = d.org_id
       WHERE d.domain = $1 AND d.status = 'approved' AND o.suspended_at IS NULL`,
      [domain],
    );
    return rows[0] ? { orgId: rows[0].org_id, providerId: rows[0].provider_id } : null;
  }

  /** Where to send the browser to sign in, plus the state to keep in a cookie. Null when the domain has no SSO. */
  async start(email: string): Promise<{ url: string; flow: SsoFlowState } | null> {
    const domain = domainOf(email);
    const target = domain ? await this.approved(domain) : null;
    if (!target) return null;
    const secret = await this.deps.credentials.get(target.orgId, target.providerId);
    if (!secret) return null;
    const doc = await this.discover(secret.issuer);
    const flow: SsoFlowState = {
      state: randomToken(24),
      nonce: randomToken(24),
      verifier: randomToken(48),
      domain,
      ...target,
    };
    const q = new URLSearchParams({
      response_type: "code",
      client_id: secret.clientId,
      redirect_uri: this.deps.callbackUrl,
      scope: "openid email profile",
      state: flow.state,
      nonce: flow.nonce,
      code_challenge: s256(flow.verifier),
      code_challenge_method: "S256",
      login_hint: email.trim(),
    });
    return { url: `${doc.authorization_endpoint}?${q}`, flow };
  }

  /** Completes the sign-in. Throws HttpError with a `code` the web app turns into a message. */
  async finish(
    flow: SsoFlowState,
    code: string,
    now = Date.now(),
  ): Promise<{ user: User; orgId: string }> {
    const target = await this.approved(flow.domain);
    if (!target || target.orgId !== flow.orgId)
      throw new HttpError(403, "Single sign-on is not active", undefined, "sso_inactive");
    const secret = await this.deps.credentials.get(flow.orgId, flow.providerId);
    if (!secret)
      throw new HttpError(403, "Single sign-on is not active", undefined, "sso_inactive");
    const doc = await this.discover(secret.issuer);
    const token = await requestJson<{ id_token?: string }>(
      this.deps.fetchImpl,
      "sso",
      doc.token_endpoint,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        rawBody: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: this.deps.callbackUrl,
          client_id: secret.clientId,
          client_secret: secret.clientSecret,
          code_verifier: flow.verifier,
        }).toString(),
      },
    );
    if (!token.id_token)
      throw new HttpError(
        401,
        "The identity provider returned no identity",
        undefined,
        "sso_failed",
      );
    const keys = await requestJson<JSONWebKeySet>(this.deps.fetchImpl, "sso", doc.jwks_uri);
    let claims: Record<string, unknown>;
    try {
      ({ payload: claims } = await jwtVerify(token.id_token, createLocalJWKSet(keys), {
        issuer: doc.issuer,
        audience: secret.clientId,
        algorithms: ["RS256", "ES256", "PS256"],
      }));
    } catch {
      throw new HttpError(
        401,
        "The identity provider's response could not be verified",
        undefined,
        "sso_failed",
      );
    }
    if (claims.nonce !== flow.nonce)
      throw new HttpError(
        401,
        "The sign-in did not start in this browser",
        undefined,
        "sso_failed",
      );
    const email = String(claims.email ?? claims.preferred_username ?? "").toLowerCase();
    if (
      !/^[^@\s]+@[^@\s]+$/.test(email) ||
      domainOf(email) !== flow.domain ||
      claims.email_verified === false
    )
      throw new HttpError(
        403,
        `Sign in with an @${flow.domain} address`,
        undefined,
        "sso_wrong_domain",
      );

    const existing = await this.deps.identity.findByEmail(email);
    const state = await this.deps.store.read(flow.orgId);
    if (existing) {
      if (!state.memberships.some((m) => m.userId === existing.id))
        throw new HttpError(
          403,
          "Ask a workspace admin to invite you first",
          undefined,
          "sso_not_member",
        );
      await this.deps.db.query(
        `UPDATE users SET email_verified_at = COALESCE(email_verified_at, now()) WHERE id = $1`,
        [existing.id],
      );
      return {
        user: {
          id: existing.id,
          name: existing.name,
          email: existing.email,
          title: existing.title,
        },
        orgId: flow.orgId,
      };
    }
    const name = String(claims.name ?? email.split("@")[0]).slice(0, 80);
    const user = await this.deps.identity.createUser({ name, email, emailVerified: true });
    await this.deps.store.write(flow.orgId, (db) => {
      db.memberships.push({
        orgId: flow.orgId,
        userId: user.id,
        role: "member",
        joinedAt: toIso(now),
      });
      db.auditLogs.unshift({
        id: newId("aud"),
        orgId: flow.orgId,
        actor: { type: "person", id: user.id },
        action: "member.joined",
        resource: `user:${user.id}`,
        at: toIso(now),
        detail: `${email} as member (single sign-on)`,
        ip: null,
      });
    });
    return { user, orgId: flow.orgId };
  }

  // ---------------------------------------------------------------- staff approval
  async listDomains() {
    const { rows } = await this.deps.db.query<{
      domain: string;
      org_id: string;
      name: string;
      provider_id: string;
      status: string;
      email: string | null;
      created_at: Date;
    }>(
      `SELECT d.domain, d.org_id, o.data->>'name' AS name, d.provider_id, d.status, u.email, d.created_at
       FROM sso_domains d JOIN organizations o ON o.id = d.org_id LEFT JOIN users u ON u.id = d.requested_by
       ORDER BY (d.status = 'pending') DESC, d.created_at DESC`,
    );
    return rows.map((r) => ({
      domain: r.domain,
      workspaceId: r.org_id,
      workspaceName: r.name,
      provider: r.provider_id,
      status: r.status as "pending" | "approved" | "rejected",
      requestedBy: r.email ?? "",
      requestedAt: new Date(r.created_at).toISOString(),
    }));
  }

  async decide(domain: string, status: "approved" | "rejected", now = Date.now()): Promise<string> {
    const { rows } = await this.deps.db.query<{ org_id: string; provider_id: string }>(
      `UPDATE sso_domains SET status = $2, decided_at = now() WHERE domain = $1 RETURNING org_id, provider_id`,
      [domain, status],
    );
    if (!rows[0]) throw new HttpError(404, "No such domain claim");
    const { org_id: orgId, provider_id: providerId } = rows[0];
    await this.deps.store.write(orgId, (db) => {
      const integration = db.integrations.find((i) => i.providerId === providerId);
      if (integration)
        integration.account = `${domain} (${status === "approved" ? "active" : "not approved by ForgePilot"})`;
      db.auditLogs.unshift({
        id: newId("aud"),
        orgId,
        actor: { type: "system", id: "forgepilot_staff" },
        action: `sso.domain_${status}`,
        resource: `integration:${providerId}`,
        at: toIso(now),
        detail: domain,
        ip: null,
      });
    });
    return orgId;
  }
}
