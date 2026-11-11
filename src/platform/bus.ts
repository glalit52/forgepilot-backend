/**
 * Workspace change notifications. Every committed write publishes
 * `{orgId, rev}`; API instances use it to push live updates (SSE) and to know
 * their cached workspace state is stale. Delivered in-process immediately and
 * to other instances through Postgres LISTEN/NOTIFY.
 */
import { EventEmitter } from "node:events";
import type { Database } from "./db";
import { randomId } from "./ids";

export interface ChangeEvent {
  orgId: string;
  rev: number;
}

export const CHANGE_CHANNEL = "fp_change";

export class ChangeBus {
  private emitter = new EventEmitter();
  readonly instanceId = randomId(8);
  private unlisten: (() => Promise<void>) | null = null;

  constructor() {
    this.emitter.setMaxListeners(0);
  }

  async attach(db: Database) {
    this.unlisten = await db.listen(CHANGE_CHANNEL, (payload) => {
      const [instance, orgId, rev] = payload.split("|");
      // Our own writes were already delivered locally.
      if (instance === this.instanceId || !orgId) return;
      this.emitter.emit("change", { orgId, rev: Number(rev) } satisfies ChangeEvent);
    });
  }

  /** Payload for pg_notify; call inside the writing transaction so it is sent on commit. */
  payload(orgId: string, rev: number): string {
    return `${this.instanceId}|${orgId}|${rev}`;
  }

  publishLocal(event: ChangeEvent) {
    this.emitter.emit("change", event);
  }

  subscribe(listener: (event: ChangeEvent) => void): () => void {
    this.emitter.on("change", listener);
    return () => this.emitter.off("change", listener);
  }

  async close() {
    await this.unlisten?.().catch(() => undefined);
    this.emitter.removeAllListeners();
  }
}
