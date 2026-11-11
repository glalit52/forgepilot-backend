/**
 * Customer webhooks: workspaces register HTTPS endpoints and receive signed
 * events (task, session, PR, test and finding activity).
 *
 * Signature: `X-ForgePilot-Signature: t=<unix seconds>,v1=<hex hmac-sha256(secret, "<t>.<body>")>`.
 * Receivers should reject timestamps older than five minutes to stop replays.
 */
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { hmacSha256, randomToken, type Vault } from "../platform/crypto";
import type { Database } from "../platform/db";
import { HttpError } from "../platform/errors";
import { newId } from "../platform/ids";
import type { FetchLike } from "./http";

export interface WebhookEndpoint {
  id: string;
  url: string;
  events: string[];
  enabled: boolean;
  createdAt: string;
}

/** True for loopback, private, link-local and other non-routable addresses. */
export function isPrivateAddress(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split(".").map(Number);
    return (
      a === 10 ||
      a === 127 ||
      a === 0 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) ||
      a >= 224
    );
  }
  const v6 = ip.toLowerCase();
  if (v6.startsWith("::ffff:")) return isPrivateAddress(v6.slice(7));
  return v6 === "::1" || v6 === "::" || /^f[cd]/.test(v6) || /^fe[89ab]/.test(v6);
}

/**
 * SSRF guard: customer-supplied URLs must be HTTPS and resolve only to public
 * addresses. Checked at registration and again before every delivery, because
 * DNS can change after registration.
 */
export async function assertPublicHttpsUrl(
  value: string,
  resolve: (host: string) => Promise<string[]> = async (host) =>
    (await lookup(host, { all: true })).map((a) => a.address),
): Promise<URL> {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new HttpError(422, "Enter a valid URL");
  }
  if (url.protocol !== "https:") throw new HttpError(422, "Webhook URLs must use https");
  if (url.username || url.password)
    throw new HttpError(422, "Webhook URLs can't contain credentials");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(host) ? [host] : await resolve(host).catch(() => [] as string[]);
  if (!addresses.length) throw new HttpError(422, "That host could not be resolved");
  if (addresses.some(isPrivateAddress))
    throw new HttpError(422, "Webhook URLs must point at a public address");
  return url;
}

export function signWebhook(secret: string, body: string, timestamp: number): string {
  return `t=${timestamp},v1=${hmacSha256(secret, `${timestamp}.${body}`)}`;
}

export class OutboundWebhooks {
  constructor(
    private db: Database,
    private vault: Vault,
    private fetchImpl: FetchLike,
    private resolve?: (host: string) => Promise<string[]>,
  ) {}

  async list(orgId: string): Promise<WebhookEndpoint[]> {
    const { rows } = await this.db.query<{
      id: string;
      url: string;
      events: string[];
      enabled: boolean;
      created_at: Date;
    }>(
      `SELECT id, url, events, enabled, created_at FROM webhook_endpoints WHERE org_id = $1 ORDER BY created_at`,
      [orgId],
    );
    return rows.map((r) => ({
      id: r.id,
      url: r.url,
      events: r.events,
      enabled: r.enabled,
      createdAt: new Date(r.created_at).toISOString(),
    }));
  }

  /** Registers an endpoint. The signing secret is returned once and stored encrypted. */
  async create(orgId: string, userId: string, input: { url: string; events: string[] }) {
    const url = await assertPublicHttpsUrl(input.url, this.resolve);
    const count = await this.db.query(`SELECT 1 FROM webhook_endpoints WHERE org_id = $1`, [orgId]);
    if (count.rows.length >= 10)
      throw new HttpError(409, "A workspace can have at most 10 webhook endpoints");
    const id = newId("whk");
    const secret = `whsec_${randomToken(24)}`;
    await this.db.query(
      `INSERT INTO webhook_endpoints (id, org_id, url, secret_ct, events, created_by) VALUES ($1, $2, $3, $4, $5::text[], $6)`,
      [
        id,
        orgId,
        url.toString(),
        this.vault.encrypt(secret, `${orgId}:${id}`),
        input.events,
        userId,
      ],
    );
    return { endpoint: (await this.list(orgId)).find((e) => e.id === id)!, secret };
  }

  async remove(orgId: string, id: string): Promise<boolean> {
    const res = await this.db.query(`DELETE FROM webhook_endpoints WHERE org_id = $1 AND id = $2`, [
      orgId,
      id,
    ]);
    return res.rowCount > 0;
  }

  /** Endpoints subscribed to an event type. An empty `events` list means "everything". */
  async subscribers(orgId: string, type: string): Promise<string[]> {
    const { rows } = await this.db.query<{ id: string }>(
      `SELECT id FROM webhook_endpoints
       WHERE org_id = $1 AND enabled AND (cardinality(events) = 0 OR $2 = ANY(events) OR split_part($2, '.', 1) || '.*' = ANY(events))`,
      [orgId, type],
    );
    return rows.map((r) => r.id);
  }

  /** One delivery attempt. Throws on a non-2xx so the job queue retries with backoff. */
  async deliver(
    orgId: string,
    endpointId: string,
    event: { id: string; type: string; occurredAt: string; data: unknown },
  ) {
    const { rows } = await this.db.query<{ url: string; secret_ct: string; enabled: boolean }>(
      `SELECT url, secret_ct, enabled FROM webhook_endpoints WHERE org_id = $1 AND id = $2`,
      [orgId, endpointId],
    );
    const endpoint = rows[0];
    if (!endpoint || !endpoint.enabled) return;
    const url = await assertPublicHttpsUrl(endpoint.url, this.resolve);
    const body = JSON.stringify({ ...event, workspaceId: orgId });
    const timestamp = Math.floor(Date.now() / 1000);
    const res = await this.fetchImpl(url, {
      method: "POST",
      // Never follow redirects: a redirect could point back into a private network.
      redirect: "manual",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "ForgePilot-Webhooks/1",
        "X-ForgePilot-Event": event.type,
        "X-ForgePilot-Delivery": event.id,
        "X-ForgePilot-Signature": signWebhook(
          this.vault.decrypt(endpoint.secret_ct, `${orgId}:${endpointId}`),
          body,
          timestamp,
        ),
      },
      body,
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status < 200 || res.status >= 300)
      throw new Error(`Webhook endpoint answered ${res.status}`);
  }
}
