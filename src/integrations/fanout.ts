/**
 * Fan-out of workspace activity to the outside world. Audit entries become
 * signed webhook deliveries; notifications go to the chat tools the workspace
 * connected. Each destination is its own job, so one slow or failing receiver
 * never blocks the others and is retried independently.
 */
import type { CredentialStore } from "../connectors/credentials";
import type { ChatNotifier } from "../connectors/messaging";
import type { OutboundWebhooks } from "../connectors/outboundWebhooks";
import type { AuditLog, Notification } from "../contract/schemas";
import type { Database } from "../platform/db";
import { enqueueJob, type Job } from "../platform/jobs";
import type { TenantStore } from "../tenancy/store";

export class Fanout {
  constructor(
    private deps: {
      db: Database;
      store: TenantStore;
      webhooks: OutboundWebhooks;
      chat: ChatNotifier;
      credentials: CredentialStore;
      appUrl: string;
    },
  ) {}

  async dispatch(job: Job): Promise<void> {
    const orgId = job.orgId!;
    const events = (job.payload.events ?? []) as AuditLog[];
    const notifications = (job.payload.notifications ?? []) as Notification[];
    for (const e of events)
      for (const endpointId of await this.deps.webhooks.subscribers(orgId, e.action))
        await enqueueJob(this.deps.db, {
          kind: "webhook.deliver",
          orgId,
          maxAttempts: 8,
          payload: {
            endpointId,
            event: {
              id: e.id,
              type: e.action,
              occurredAt: e.at,
              data: { actor: e.actor, resource: e.resource, detail: e.detail },
            },
          },
        });
    if (!notifications.length) return;
    const state = await this.deps.store.read(orgId);
    for (const provider of ["slack", "teams"] as const) {
      if (!state.integrations.some((i) => i.providerId === provider && i.status === "connected"))
        continue;
      for (const n of notifications)
        await enqueueJob(this.deps.db, {
          kind: "chat.notify",
          orgId,
          maxAttempts: 4,
          payload: { provider, title: n.title, body: n.body, href: n.href },
        });
    }
  }

  async deliverWebhook(job: Job): Promise<void> {
    const event = job.payload.event as {
      id: string;
      type: string;
      occurredAt: string;
      data: unknown;
    };
    await this.deps.webhooks.deliver(job.orgId!, String(job.payload.endpointId), event);
  }

  async notifyChat(job: Job): Promise<void> {
    const provider = job.payload.provider as "slack" | "teams";
    const secret = await this.deps.credentials.get(job.orgId!, provider);
    // Connected without stored credentials (e.g. demo data): nothing to send to.
    if (!secret) return;
    const msg = {
      title: String(job.payload.title),
      body: String(job.payload.body),
      url: `${this.deps.appUrl}${String(job.payload.href)}`,
    };
    if (provider === "slack") await this.deps.chat.slack(secret, msg);
    else await this.deps.chat.teams(secret, msg);
  }
}
