/** Stripe webhooks → workspace plan and invoices. Deduplicated by event id, processed in a job. */
import type Stripe from "stripe";
import type { StripeBilling } from "../connectors/stripe";
import type { PlanId } from "../contract/schemas";
import { planById } from "../contract/domain/plans";
import { audit } from "../domain/loop";
import type { Database } from "../platform/db";
import { toIso } from "../platform/ids";
import type { Job } from "../platform/jobs";
import type { TenantStore } from "../tenancy/store";

export class StripeEvents {
  constructor(private deps: { db: Database; store: TenantStore; billing: StripeBilling }) {}

  async accept(event: Stripe.Event): Promise<boolean> {
    return this.deps.db.tx(async (q) => {
      const res = await q.query(
        `INSERT INTO webhook_deliveries (provider, delivery_id, event, payload) VALUES ('stripe', $1, $2, $3::jsonb)
         ON CONFLICT DO NOTHING`,
        [event.id, event.type, JSON.stringify(event)],
      );
      if (!res.rowCount) return false;
      await q.query(
        `INSERT INTO jobs (kind, payload, dedupe_key) VALUES ('stripe.webhook', $1::jsonb, $2)`,
        [JSON.stringify({ eventId: event.id }), `stripe.webhook:${event.id}`],
      );
      return true;
    });
  }

  async process(job: Job): Promise<void> {
    const eventId = String(job.payload.eventId);
    const { rows } = await this.deps.db.query<{ payload: Stripe.Event; status: string }>(
      `SELECT payload, status FROM webhook_deliveries WHERE provider = 'stripe' AND delivery_id = $1`,
      [eventId],
    );
    if (!rows[0] || rows[0].status === "processed") return;
    await this.handle(rows[0].payload);
    await this.deps.db.query(
      `UPDATE webhook_deliveries SET status = 'processed', processed_at = now() WHERE provider = 'stripe' AND delivery_id = $1`,
      [eventId],
    );
  }

  private async setPlan(
    orgId: string,
    plan: PlanId,
    cycle: "monthly" | "annual" | null,
    reason: string,
  ) {
    await this.deps.store.write(orgId, (db) => {
      const org = db.organizations[0];
      if (org.plan === plan && (!cycle || org.billingCycle === cycle)) return;
      org.plan = plan;
      if (cycle) org.billingCycle = cycle;
      org.trialEndsAt = null;
      audit(
        db,
        orgId,
        { type: "system", id: "billing" },
        "billing.plan_changed",
        "billing",
        `${planById(plan).name} (${reason})`,
        Date.now(),
      );
    });
  }

  private async handle(event: Stripe.Event) {
    const { billing } = this.deps;
    const customerOf = (v: string | { id: string } | null | undefined) =>
      typeof v === "string" ? v : (v?.id ?? null);
    switch (event.type) {
      case "checkout.session.completed": {
        const s = event.data.object;
        const orgId = s.metadata?.orgId ?? s.client_reference_id;
        const customer = customerOf(s.customer);
        if (!orgId || !customer) return;
        await billing.recordSubscription(
          orgId,
          customer,
          customerOf(s.subscription as string | { id: string } | null),
        );
        const plan = s.metadata?.plan as PlanId | undefined;
        if (plan)
          await this.setPlan(
            orgId,
            plan,
            (s.metadata?.billingCycle as "monthly" | "annual") ?? null,
            "checkout completed",
          );
        return;
      }
      case "customer.subscription.created":
      case "customer.subscription.updated":
      case "customer.subscription.deleted": {
        const sub = event.data.object;
        const customer = customerOf(sub.customer);
        const orgId =
          sub.metadata?.orgId ?? (customer ? await billing.orgForCustomer(customer) : null);
        if (!orgId || !customer) return;
        const active =
          event.type !== "customer.subscription.deleted" &&
          ["active", "trialing", "past_due"].includes(sub.status);
        await billing.recordSubscription(orgId, customer, active ? sub.id : null);
        if (!active) return this.setPlan(orgId, "free", null, "subscription ended");
        const mapped = billing.planForPrice(sub.items.data[0]?.price.id ?? "");
        if (mapped) await this.setPlan(orgId, mapped.plan, mapped.cycle, "subscription updated");
        return;
      }
      case "invoice.paid": {
        const inv = event.data.object;
        const customer = customerOf(inv.customer);
        const orgId = customer ? await billing.orgForCustomer(customer) : null;
        if (!orgId || !inv.id) return;
        const issued = (inv.created ?? Math.floor(Date.now() / 1000)) * 1000;
        const total = (inv.amount_paid ?? 0) / 100;
        await this.deps.store.write(orgId, (db) => {
          if (db.invoices.some((i) => i.id === inv.id)) return;
          db.invoices.push({
            id: inv.id!,
            orgId,
            period: toIso(issued).slice(0, 7),
            status: "paid",
            subscriptionUsd: total,
            usageUsd: 0,
            totalUsd: total,
            issuedAt: toIso(issued),
          });
        });
        return;
      }
      default:
        return;
    }
  }
}
