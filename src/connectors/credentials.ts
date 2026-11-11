/**
 * Integration credentials. Secrets are encrypted with the vault key before
 * they reach the database and are only decrypted at the moment a connector
 * needs them; API responses never include them.
 */
import type { Vault } from "../platform/crypto";
import type { Database, Queryable } from "../platform/db";
import { HttpError } from "../platform/errors";
import { ConnectorError, requestJson, type FetchLike } from "./http";

export type Secret = Record<string, string>;

/** Hosts a customer-supplied URL may point at, per provider. Prevents using a connector to reach internal services. */
const ALLOWED_HOSTS: Record<string, RegExp> = {
  slack: /^hooks\.slack\.com$/,
  teams: /(^|\.)webhook\.office\.com$|(^|\.)logic\.azure\.com$/,
  jira: /^[a-z0-9-]+\.atlassian\.net$/,
};

export function assertProviderUrl(providerId: string, value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new HttpError(422, "Enter a valid URL");
  }
  const allowed = ALLOWED_HOSTS[providerId];
  if (url.protocol !== "https:" || !allowed || !allowed.test(url.hostname))
    throw new HttpError(422, `That URL is not a valid ${providerId} address`);
  return url;
}

export class CredentialStore {
  constructor(
    private db: Database,
    private vault: Vault,
    private fetchImpl: FetchLike,
  ) {}

  async put(q: Queryable, orgId: string, providerId: string, secret: Secret) {
    const ciphertext = this.vault.encrypt(JSON.stringify(secret), `${orgId}:${providerId}`);
    await q.query(
      `INSERT INTO credentials (org_id, provider_id, ciphertext) VALUES ($1, $2, $3)
       ON CONFLICT (org_id, provider_id) DO UPDATE SET ciphertext = EXCLUDED.ciphertext, updated_at = now()`,
      [orgId, providerId, ciphertext],
    );
  }

  async remove(q: Queryable, orgId: string, providerId: string) {
    await q.query(`DELETE FROM credentials WHERE org_id = $1 AND provider_id = $2`, [
      orgId,
      providerId,
    ]);
  }

  async get(orgId: string, providerId: string): Promise<Secret | null> {
    const { rows } = await this.db.query<{ ciphertext: string }>(
      `SELECT ciphertext FROM credentials WHERE org_id = $1 AND provider_id = $2`,
      [orgId, providerId],
    );
    if (!rows[0]) return null;
    return JSON.parse(this.vault.decrypt(rows[0].ciphertext, `${orgId}:${providerId}`)) as Secret;
  }

  /**
   * Proves a credential works before it is stored, so a typo is caught at
   * connect time rather than when the first agent run fails.
   */
  async verify(providerId: string, secret: Secret): Promise<{ account?: string }> {
    const need = (field: string) => {
      const v = secret[field];
      if (!v) throw new HttpError(422, `Missing credential field "${field}"`);
      return v;
    };
    try {
      switch (providerId) {
        case "claude_code": {
          await requestJson(
            this.fetchImpl,
            "anthropic",
            "https://api.anthropic.com/v1/models?limit=1",
            {
              headers: { "x-api-key": need("apiKey"), "anthropic-version": "2023-06-01" },
            },
          );
          return { account: "Anthropic API key" };
        }
        case "openai_codex": {
          await requestJson(this.fetchImpl, "openai", "https://api.openai.com/v1/models", {
            headers: { Authorization: `Bearer ${need("apiKey")}` },
          });
          return { account: "OpenAI API key" };
        }
        case "slack": {
          if (secret.webhookUrl) {
            assertProviderUrl("slack", secret.webhookUrl);
            return {};
          }
          const res = await requestJson<{ ok: boolean; team?: string; error?: string }>(
            this.fetchImpl,
            "slack",
            "https://slack.com/api/auth.test",
            { method: "POST", headers: { Authorization: `Bearer ${need("botToken")}` } },
          );
          if (!res.ok)
            throw new HttpError(422, `Slack rejected the token (${res.error ?? "unknown error"})`);
          need("channel");
          return { account: res.team };
        }
        case "teams":
          assertProviderUrl("teams", need("webhookUrl"));
          return {};
        case "linear": {
          const res = await requestJson<{
            data?: { organization?: { name: string } };
            errors?: unknown[];
          }>(this.fetchImpl, "linear", "https://api.linear.app/graphql", {
            method: "POST",
            headers: { Authorization: need("apiKey") },
            body: { query: "{ organization { name } }" },
          });
          if (res.errors?.length || !res.data?.organization)
            throw new HttpError(422, "Linear rejected the API key");
          return { account: res.data.organization.name };
        }
        case "jira": {
          const base = assertProviderUrl("jira", need("baseUrl"));
          const res = await requestJson<{ displayName?: string }>(
            this.fetchImpl,
            "jira",
            `${base.origin}/rest/api/3/myself`,
            {
              headers: {
                Authorization: `Basic ${Buffer.from(`${need("email")}:${need("apiToken")}`).toString("base64")}`,
              },
            },
          );
          return { account: `${base.hostname} (${res.displayName ?? secret.email})` };
        }
        default:
          // Providers without a live connector yet: the secret is stored, not exercised.
          return {};
      }
    } catch (err) {
      if (err instanceof ConnectorError && !err.transient)
        throw new HttpError(422, `${err.provider} rejected these credentials (HTTP ${err.status})`);
      throw err;
    }
  }
}
