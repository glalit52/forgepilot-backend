/** Periodic housekeeping per workspace: data retention and metered-usage reporting. */
import type { StripeBilling } from "../connectors/stripe";
import type { Database } from "../platform/db";
import type { Logger } from "../platform/logger";
import type { TenantStore } from "../tenancy/store";

const DAY = 86_400_000;

export class Maintenance {
  constructor(
    private deps: { db: Database; store: TenantStore; billing: StripeBilling; log: Logger },
  ) {}

  private async workspaces(): Promise<{ id: string; customer: string | null }[]> {
    const { rows } = await this.deps.db.query<{ id: string; stripe_customer_id: string | null }>(
      `SELECT id, stripe_customer_id FROM organizations WHERE NOT is_demo ORDER BY id`,
    );
    return rows.map((r) => ({ id: r.id, customer: r.stripe_customer_id }));
  }

  /**
   * Applies each workspace's retention policy (Settings → Policies): session logs,
   * stored artifacts and audit entries older than the configured number of days are removed.
   */
  async applyRetention(now = Date.now()): Promise<void> {
    for (const { id } of await this.workspaces()) {
      try {
        const state = await this.deps.store.read(id);
        const policy = state.policies[0];
        if (!policy) continue;
        const { logs, artifacts, audit } = policy.retentionDays;
        await this.deps.db.query(
          `DELETE FROM session_log_lines WHERE org_id = $1 AND at < now() - ($2::int * interval '1 day')`,
          [id, Math.max(1, Math.round(logs))],
        );
        await this.deps.db.query(
          `DELETE FROM artifacts WHERE org_id = $1 AND created_at < now() - ($2::int * interval '1 day')`,
          [id, Math.max(1, Math.round(artifacts))],
        );
        const cutoff = now - Math.max(1, audit) * DAY;
        if (state.auditLogs.some((l) => Date.parse(l.at) < cutoff))
          await this.deps.store.write(id, (db) => {
            db.auditLogs = db.auditLogs.filter((l) => Date.parse(l.at) >= cutoff);
          });
      } catch (err) {
        this.deps.log.error({ err, orgId: id }, "retention failed for workspace");
      }
    }
  }

  /**
   * Sends completed days of metered usage to Stripe, once per workspace, meter and
   * day. A row in `usage_reports` marks what was sent; Stripe additionally
   * de-duplicates on the event identifier, so a crash between the two is harmless.
   */
  async reportUsage(now = Date.now()): Promise<number> {
    const { billing } = this.deps;
    const meters = billing.configured ? billing.meteredMeters : [];
    if (!meters.length) return 0;
    const today = new Date(now).toISOString().slice(0, 10);
    const oldest = new Date(now - 35 * DAY).toISOString().slice(0, 10);
    let sent = 0;
    for (const { id, customer } of await this.workspaces()) {
      if (!customer) continue;
      try {
        const state = await this.deps.store.read(id);
        const totals = new Map<string, number>();
        for (const u of state.usageRecords)
          if (meters.includes(u.meter) && u.date < today && u.date >= oldest)
            totals.set(`${u.meter}|${u.date}`, (totals.get(`${u.meter}|${u.date}`) ?? 0) + u.units);
        if (!totals.size) continue;
        const done = await this.deps.db.query<{ meter: string; day: string }>(
          `SELECT meter, to_char(day, 'YYYY-MM-DD') AS day FROM usage_reports WHERE org_id = $1 AND day >= $2::date`,
          [id, oldest],
        );
        const reported = new Set(done.rows.map((r) => `${r.meter}|${r.day}`));
        for (const [key, units] of totals) {
          if (reported.has(key) || units <= 0) continue;
          const [meter, day] = key.split("|");
          if (!(await billing.reportUsage({ customerId: customer, meter, day, units, orgId: id })))
            continue;
          await this.deps.db.query(
            `INSERT INTO usage_reports (org_id, meter, day, units) VALUES ($1, $2, $3::date, $4) ON CONFLICT DO NOTHING`,
            [id, meter, day, units],
          );
          sent++;
        }
      } catch (err) {
        this.deps.log.error({ err, orgId: id }, "usage reporting failed for workspace");
      }
    }
    return sent;
  }
}
