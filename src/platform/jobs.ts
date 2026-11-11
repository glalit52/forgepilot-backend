/**
 * Durable job queue on Postgres (`FOR UPDATE SKIP LOCKED`).
 *
 * Why not Redis/Temporal yet: jobs are enqueued in the same transaction as the
 * state change that needs them, which gives exactly the outbox guarantee the
 * PRD asks for (§13.4) with one moving part. The interface is small enough to
 * swap for a dedicated workflow engine when volume justifies it.
 *
 * Delivery is at-least-once: handlers must be idempotent.
 */
import { hostname } from "node:os";
import type { Database, Queryable } from "./db";
import type { Logger } from "./logger";
import { randomId } from "./ids";
import type { Metrics } from "./metrics";

export interface JobInput {
  kind: string;
  orgId?: string | null;
  payload?: Record<string, unknown>;
  /** Earliest time the job may run. */
  runAt?: Date;
  /** While a queued job with this key exists, enqueueing again only pulls its run time earlier. */
  dedupeKey?: string;
  maxAttempts?: number;
}

export interface Job {
  id: number;
  kind: string;
  orgId: string | null;
  payload: Record<string, unknown>;
  attempts: number;
  maxAttempts: number;
}

export type JobHandler = (job: Job, ctx: { signal: AbortSignal }) => Promise<void>;

/** Thrown by a handler to fail a job permanently (no retries). */
export class PermanentJobError extends Error {}

export async function enqueueJob(q: Queryable, job: JobInput): Promise<void> {
  await q.query(
    `INSERT INTO jobs (kind, org_id, payload, run_at, dedupe_key, max_attempts)
     VALUES ($1, $2, $3::jsonb, COALESCE($4::timestamptz, now()), $5, $6)
     ON CONFLICT (dedupe_key) WHERE status = 'queued' AND dedupe_key IS NOT NULL
     DO UPDATE SET run_at = LEAST(jobs.run_at, EXCLUDED.run_at)`,
    [
      job.kind,
      job.orgId ?? null,
      JSON.stringify(job.payload ?? {}),
      job.runAt ? job.runAt.toISOString() : null,
      job.dedupeKey ?? null,
      job.maxAttempts ?? 5,
    ],
  );
}

interface JobRow {
  id: number;
  kind: string;
  org_id: string | null;
  payload: Record<string, unknown>;
  attempts: number;
  max_attempts: number;
}

export class JobWorker {
  private handlers = new Map<string, JobHandler>();
  private running = new Map<number, AbortController>();
  private timer: NodeJS.Timeout | null = null;
  private stopped = true;
  private polling = false;
  private idle: (() => void)[] = [];
  readonly workerId = `${hostname()}-${process.pid}-${randomId(4)}`;

  constructor(
    private db: Database,
    private log: Logger,
    private metrics: Metrics,
    private opts: {
      concurrency: number;
      pollMs?: number;
      /** A running job whose lock is older than this is assumed dead and re-queued. */
      visibilityTimeoutMs?: number;
    },
  ) {}

  register(kind: string, handler: JobHandler) {
    this.handlers.set(kind, handler);
  }

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    const tick = () => {
      if (this.stopped) return;
      void this.poll().finally(() => {
        if (!this.stopped) this.timer = setTimeout(tick, this.opts.pollMs ?? 500);
      });
    };
    tick();
  }

  /** Stops polling, aborts running handlers and waits for them to settle. */
  async stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    for (const c of this.running.values()) c.abort();
    const deadline = Date.now() + 10_000;
    while ((this.running.size || this.polling) && Date.now() < deadline)
      await new Promise((r) => setTimeout(r, 25));
  }

  /** Runs everything that is due right now and resolves when the worker is idle. For tests and CLIs. */
  async drain(): Promise<void> {
    for (;;) {
      const claimed = await this.poll();
      if (this.running.size) await new Promise<void>((resolve) => this.idle.push(resolve));
      else if (!claimed) return;
    }
  }

  async poll(): Promise<number> {
    if (this.polling) return 0;
    this.polling = true;
    try {
      const free = this.opts.concurrency - this.running.size;
      if (free <= 0) return 0;
      await this.db.query(
        `UPDATE jobs SET status = 'queued', locked_by = NULL, locked_at = NULL,
                last_error = 'worker lost (visibility timeout)'
         WHERE status = 'running' AND locked_at < now() - ($1::int * interval '1 millisecond')`,
        [this.opts.visibilityTimeoutMs ?? 30 * 60_000],
      );
      const kinds = [...this.handlers.keys()];
      if (!kinds.length) return 0;
      const { rows } = await this.db.query<JobRow>(
        `UPDATE jobs SET status = 'running', locked_by = $1, locked_at = now(), attempts = attempts + 1
         WHERE id IN (
           SELECT id FROM jobs
           WHERE status = 'queued' AND run_at <= now() AND kind = ANY($3::text[])
           ORDER BY run_at, id
           LIMIT $2
           FOR UPDATE SKIP LOCKED
         )
         RETURNING id, kind, org_id, payload, attempts, max_attempts`,
        [this.workerId, free, kinds],
      );
      for (const row of rows) void this.execute(row);
      return rows.length;
    } catch (err) {
      this.log.error({ err }, "job poll failed");
      return 0;
    } finally {
      this.polling = false;
    }
  }

  private async execute(row: JobRow) {
    const controller = new AbortController();
    this.running.set(row.id, controller);
    const started = Date.now();
    const job: Job = {
      id: row.id,
      kind: row.kind,
      orgId: row.org_id,
      payload: row.payload,
      attempts: row.attempts,
      maxAttempts: row.max_attempts,
    };
    try {
      await this.handlers.get(row.kind)!(job, { signal: controller.signal });
      await this.db.query(
        `UPDATE jobs SET status = 'done', finished_at = now(), locked_by = NULL WHERE id = $1`,
        [row.id],
      );
      this.metrics.jobs.inc({ kind: row.kind, outcome: "done" });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const permanent = err instanceof PermanentJobError || row.attempts >= row.max_attempts;
      // Exponential backoff with a ceiling: 2s, 8s, 32s, … up to 10 minutes.
      const delayMs = Math.min(600_000, 2_000 * 4 ** (row.attempts - 1));
      await this.db
        .query(
          permanent
            ? `UPDATE jobs SET status = 'failed', finished_at = now(), locked_by = NULL, last_error = $2 WHERE id = $1`
            : `UPDATE jobs SET status = 'queued', locked_by = NULL, locked_at = NULL, last_error = $2,
                      run_at = now() + ($3::int * interval '1 millisecond') WHERE id = $1`,
          permanent ? [row.id, message.slice(0, 2000)] : [row.id, message.slice(0, 2000), delayMs],
        )
        .catch((e) => this.log.error({ err: e }, "failed to record job failure"));
      this.metrics.jobs.inc({ kind: row.kind, outcome: permanent ? "failed" : "retried" });
      this.log[permanent ? "error" : "warn"](
        { err, jobId: row.id, kind: row.kind, orgId: row.org_id, attempt: row.attempts },
        permanent ? "job failed permanently" : "job failed; will retry",
      );
    } finally {
      this.metrics.jobDuration.observe({ kind: row.kind }, (Date.now() - started) / 1000);
      this.running.delete(row.id);
      if (!this.running.size) this.idle.splice(0).forEach((resolve) => resolve());
    }
  }
}
