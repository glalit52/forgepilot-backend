/**
 * Stripe billing. Stripe owns the subscription; the workspace's plan follows
 * what Stripe reports (directly after a successful change, and again through
 * webhooks, which are the durable source of truth).
 */
import Stripe from "stripe";
import type { Organization, PlanId } from "../contract/schemas";
import type { Database } from "../platform/db";
import { HttpError } from "../platform/errors";

export interface StripeConfig {
  secretKey?: string;
  webhookSecret?: string;
  prices: Record<string, { monthly?: string; annual?: string }>;
  meters: Record<string, string>;
}

export type BillingCycle = Organization["billingCycle"];

export interface PaymentMethodSummary {
  brand: string;
  last4: string;
  expires: string;
}

export class StripeBilling {
  private client: Stripe | null;

  constructor(
    private cfg: StripeConfig,
    private db: Database,
    private appUrl: string,
    client?: Stripe,
  ) {
    this.client = client ?? (cfg.secretKey ? new Stripe(cfg.secretKey) : null);
  }

  get configured(): boolean {
    return !!this.client;
  }

  private get stripe(): Stripe {
    if (!this.client) throw new HttpError(503, "Billing is not configured");
    return this.client;
  }

  priceFor(plan: PlanId, cycle: BillingCycle): string {
    const price = this.cfg.prices[plan]?.[cycle];
    if (!price)
      throw new HttpError(409, `The ${plan} plan is not available for ${cycle} billing yet`);
    return price;
  }

  /** Reverse lookup used by webhooks: which plan does this Stripe price mean? */
  planForPrice(priceId: string): { plan: PlanId; cycle: BillingCycle } | null {
    for (const [plan, cycles] of Object.entries(this.cfg.prices)) {
      if (cycles.monthly === priceId) return { plan: plan as PlanId, cycle: "monthly" };
      if (cycles.annual === priceId) return { plan: plan as PlanId, cycle: "annual" };
    }
    return null;
  }

  private async refs(orgId: string) {
    const { rows } = await this.db.query<{
      stripe_customer_id: string | null;
      stripe_subscription_id: string | null;
    }>(`SELECT stripe_customer_id, stripe_subscription_id FROM organizations WHERE id = $1`, [
      orgId,
    ]);
    return {
      customerId: rows[0]?.stripe_customer_id ?? null,
      subscriptionId: rows[0]?.stripe_subscription_id ?? null,
    };
  }

  private async ensureCustomer(org: Organization, email: string): Promise<string> {
    const { customerId } = await this.refs(org.id);
    if (customerId) return customerId;
    const customer = await this.stripe.customers.create(
      { name: org.name, email, metadata: { orgId: org.id } },
      // A retried request must not create a second customer for the same workspace.
      { idempotencyKey: `customer:${org.id}` },
    );
    await this.db.query(
      `UPDATE organizations SET stripe_customer_id = $2 WHERE id = $1 AND stripe_customer_id IS NULL`,
      [org.id, customer.id],
    );
    return (await this.refs(org.id)).customerId ?? customer.id;
  }

  /**
   * Moves the subscription to `plan`. A workspace without a subscription is
   * sent to Stripe Checkout (402 with the URL); the plan changes when the
   * checkout webhook arrives.
   */
  async changePlan(input: {
    org: Organization;
    plan: PlanId;
    billingCycle: BillingCycle;
    userEmail: string;
  }): Promise<void> {
    const { org, plan, billingCycle } = input;
    const { subscriptionId } = await this.refs(org.id);
    if (plan === "free") {
      if (subscriptionId) {
        await this.stripe.subscriptions.cancel(subscriptionId);
        await this.db.query(
          `UPDATE organizations SET stripe_subscription_id = NULL WHERE id = $1`,
          [org.id],
        );
      }
      return;
    }
    const price = this.priceFor(plan, billingCycle);
    if (subscriptionId) {
      const sub = await this.stripe.subscriptions.retrieve(subscriptionId);
      const item = sub.items.data[0];
      if (!item) throw new HttpError(409, "The subscription has no items to change");
      if (item.price.id !== price)
        await this.stripe.subscriptions.update(subscriptionId, {
          items: [{ id: item.id, price }],
          proration_behavior: "create_prorations",
          metadata: { orgId: org.id, plan, billingCycle },
        });
      return;
    }
    const customer = await this.ensureCustomer(org, input.userEmail);
    const session = await this.stripe.checkout.sessions.create({
      mode: "subscription",
      customer,
      client_reference_id: org.id,
      line_items: [{ price, quantity: 1 }],
      success_url: `${this.appUrl}/app/billing?checkout=success`,
      cancel_url: `${this.appUrl}/app/billing?checkout=cancelled`,
      subscription_data: { metadata: { orgId: org.id, plan, billingCycle } },
      metadata: { orgId: org.id, plan, billingCycle },
    });
    throw new HttpError(
      402,
      "Add a payment method to start this plan",
      { checkoutUrl: session.url },
      "checkout_required",
    );
  }

  /** Self-service portal: invoices, card, cancellation. */
  async portalUrl(orgId: string): Promise<string> {
    const { customerId } = await this.refs(orgId);
    if (!customerId) throw new HttpError(409, "This workspace has no billing account yet");
    const session = await this.stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: `${this.appUrl}/app/billing`,
    });
    return session.url;
  }

  async paymentMethod(orgId: string): Promise<PaymentMethodSummary | null> {
    const { customerId } = await this.refs(orgId);
    if (!customerId) return null;
    const customer = await this.stripe.customers.retrieve(customerId, {
      expand: ["invoice_settings.default_payment_method"],
    });
    if (customer.deleted) return null;
    const pm = customer.invoice_settings?.default_payment_method;
    const card = pm && typeof pm !== "string" ? pm.card : null;
    if (!card) return null;
    return {
      brand: card.brand.charAt(0).toUpperCase() + card.brand.slice(1),
      last4: card.last4,
      expires: `${String(card.exp_month).padStart(2, "0")}/${String(card.exp_year).slice(-2)}`,
    };
  }

  /** Verifies the signature and parses the event. Throws 400 on a bad signature. */
  parseWebhook(rawBody: Buffer, signature: string | undefined): Stripe.Event {
    if (!this.cfg.webhookSecret) throw new HttpError(503, "Stripe webhooks are not configured");
    try {
      return this.stripe.webhooks.constructEvent(rawBody, signature ?? "", this.cfg.webhookSecret);
    } catch {
      throw new HttpError(400, "Invalid Stripe signature");
    }
  }

  /**
   * Sends one day's usage for one meter. The identifier makes it idempotent on
   * Stripe's side, so a retried job can never bill the same usage twice.
   */
  async reportUsage(input: {
    customerId: string;
    meter: string;
    day: string;
    units: number;
    orgId: string;
  }): Promise<boolean> {
    const eventName = this.cfg.meters[input.meter];
    if (!eventName) return false;
    await this.stripe.billing.meterEvents.create({
      event_name: eventName,
      identifier: `${input.orgId}:${input.meter}:${input.day}`,
      // End of the usage day, so it lands in the right billing period.
      timestamp: Math.floor(Date.parse(`${input.day}T23:59:59Z`) / 1000),
      payload: {
        stripe_customer_id: input.customerId,
        value: String(Math.round(input.units * 100) / 100),
      },
    });
    return true;
  }

  get meteredMeters(): string[] {
    return Object.keys(this.cfg.meters);
  }

  async orgForCustomer(customerId: string): Promise<string | null> {
    const { rows } = await this.db.query<{ id: string }>(
      `SELECT id FROM organizations WHERE stripe_customer_id = $1`,
      [customerId],
    );
    return rows[0]?.id ?? null;
  }

  async recordSubscription(orgId: string, customerId: string, subscriptionId: string | null) {
    await this.db.query(
      `UPDATE organizations SET stripe_customer_id = COALESCE(stripe_customer_id, $2), stripe_subscription_id = $3 WHERE id = $1`,
      [orgId, customerId, subscriptionId],
    );
  }
}
