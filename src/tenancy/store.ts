/**
 * TenantStore: the unit of work for one workspace.
 *
 *  read(orgId)        → an immutable snapshot of the workspace (cached, revision-checked)
 *  write(orgId, fn)   → runs `fn` on a private draft inside a transaction that holds the
 *                       workspace row lock, then persists exactly the entities that changed
 *
 * Consistency
 *  - One writer per workspace at a time (row lock across processes, mutex inside one).
 *  - Every write bumps `organizations.rev`; a cached snapshot is only served after its
 *    revision is confirmed against the database, so reads see every committed write.
 *  - Other instances catch up incrementally: only rows with a newer `rev` are fetched.
 *  - Changed entities are validated against the contract schema before they are stored.
 *
 * Known limit: a workspace is held in memory as a whole. That is fine for thousands of
 * entities per workspace; high-volume collections (test results, audit log) are the first
 * candidates to move behind dedicated queries when a tenant outgrows it.
 */
import type { Organization, Role, User } from "../contract/schemas";
import { OrganizationSchema } from "../contract/schemas";
import type { ChangeBus } from "../platform/bus";
import { CHANGE_CHANNEL } from "../platform/bus";
import type { Database, Queryable } from "../platform/db";
import { HttpError } from "../platform/errors";
import { newId } from "../platform/ids";
import { enqueueJob, type JobInput } from "../platform/jobs";
import type { Logger } from "../platform/logger";
import type { Metrics } from "../platform/metrics";
import { KeyedMutex } from "../platform/mutex";
import {
  bindEffects,
  emptyState,
  RECORD_COLLECTIONS,
  RECORD_COLLECTION_NAMES,
  type Effects,
  type ExecutionMode,
  type RecordCollection,
  type TenantState,
} from "./state";

interface Entry {
  obj: object;
  json: string;
  seq: number;
}

interface Cached {
  rev: number;
  state: TenantState;
  entries: Record<RecordCollection, Map<string, Entry>>;
  orgJson: string;
  syncedAt: number;
}

interface OrgRow {
  rev: number;
  data: Organization;
}

interface RecordRow {
  collection: RecordCollection;
  id: string;
  data: object;
  seq: number;
  deleted?: boolean;
}

export interface StoreOptions {
  mode: ExecutionMode;
  sim: Effects["sim"];
  cacheSize: number;
  /** Freeze snapshots so an accidental mutation on the read path throws instead of corrupting the cache. */
  freeze: boolean;
}

/** Called with the draft just before it is persisted; the place to schedule follow-up work. */
export type BeforeCommitHook = (
  draft: TenantState,
  effects: Effects,
  change: { newAuditLogs: object[]; newNotifications: object[] },
) => void;

const MAX_INCREMENTAL_AGE_MS = 12 * 3_600_000;

export class TenantStore {
  private cache = new Map<string, Cached>();
  private mutex = new KeyedMutex();
  private keys = new WeakMap<object, string>();
  private beforeCommit: BeforeCommitHook[] = [];

  constructor(
    private db: Database,
    private bus: ChangeBus,
    private log: Logger,
    private metrics: Metrics,
    private opts: StoreOptions,
  ) {}

  onBeforeCommit(hook: BeforeCommitHook) {
    this.beforeCommit.push(hook);
  }

  // ---------------------------------------------------------------- read
  async read(orgId: string): Promise<TenantState> {
    return this.mutex.run(orgId, async () => {
      const row = await this.orgRow(this.db, orgId, false);
      const cached = await this.sync(orgId, this.db, row);
      this.bindReadEffects(cached.state);
      return cached.state;
    });
  }

  /** The cached snapshot without a database round-trip (may be slightly stale). */
  peek(orgId: string): TenantState | undefined {
    return this.cache.get(orgId)?.state;
  }

  invalidate(orgId?: string) {
    if (orgId) this.cache.delete(orgId);
    else this.cache.clear();
  }

  // ---------------------------------------------------------------- write
  async write<T>(
    orgId: string,
    fn: (draft: TenantState, effects: Effects) => T | Promise<T>,
  ): Promise<T> {
    return this.mutex.run(orgId, async () => {
      const afterCommit: (() => void | Promise<void>)[] = [];
      const outcome = await this.db.tx(async (q) => {
        const row = await this.orgRow(q, orgId, true);
        const cached = await this.sync(orgId, q, row);
        const draft = this.cloneState(cached.state);
        const jobs: JobInput[] = [];
        const effects: Effects = {
          mode: this.opts.mode,
          sim: this.opts.sim,
          enqueue: (job) => jobs.push({ ...job, orgId: job.orgId ?? orgId }),
          afterCommit: (cb) => afterCommit.push(cb),
          q,
        };
        bindEffects(draft, effects);
        const result = await fn(draft, effects);

        const plan = this.diff(orgId, cached, draft);
        if (plan.changed)
          for (const hook of this.beforeCommit)
            hook(draft, effects, {
              newAuditLogs: plan.inserted.auditLogs ?? [],
              newNotifications: plan.inserted.notifications ?? [],
            });
        // Hooks may have touched the draft (e.g. scheduling fields), so diff again if needed.
        const finalPlan =
          plan.changed && this.beforeCommit.length ? this.diff(orgId, cached, draft) : plan;

        let next: Cached | null = null;
        if (finalPlan.changed) {
          const rev = row.rev + 1;
          next = await this.persist(q, orgId, rev, cached, draft, finalPlan);
          await q.query(`SELECT pg_notify($1, $2)`, [CHANGE_CHANNEL, this.bus.payload(orgId, rev)]);
        }
        for (const job of jobs) await enqueueJob(q, job);
        return { result, next };
      });

      if (outcome.next) {
        this.put(orgId, outcome.next);
        this.bus.publishLocal({ orgId, rev: outcome.next.rev });
      }
      for (const cb of afterCommit) {
        try {
          await cb();
        } catch (err) {
          this.log.error({ err, orgId }, "afterCommit callback failed");
        }
      }
      return outcome.result;
    });
  }

  // ---------------------------------------------------------------- provisioning
  /** Inserts a new workspace with its initial entities. Call inside a transaction. */
  async createOrganization(
    q: Queryable,
    org: Organization,
    initial: Partial<Pick<TenantState, RecordCollection>>,
    opts: { isDemo?: boolean } = {},
  ): Promise<void> {
    OrganizationSchema.parse(org);
    await q.query(
      `INSERT INTO organizations (id, slug, data, rev, is_demo, created_at) VALUES ($1, $2, $3::jsonb, 1, $4, $5)`,
      [org.id, org.slug, JSON.stringify(org), opts.isDemo ?? false, org.createdAt],
    );
    const upserts: { c: string; i: string; d: unknown }[] = [];
    for (const name of RECORD_COLLECTION_NAMES) {
      const items = (initial[name] ?? []) as object[];
      const spec = RECORD_COLLECTIONS[name];
      const ordered = spec.order === "desc" ? [...items].reverse() : items;
      for (const item of ordered) {
        const parsed = spec.schema.safeParse(item);
        if (!parsed.success)
          throw new Error(`Invalid ${name} entity: ${parsed.error.issues[0]?.message}`);
        upserts.push({ c: name, i: this.keyOf(name, item), d: item });
      }
    }
    await this.upsertRecords(q, org.id, 1, upserts);
  }

  // ---------------------------------------------------------------- internals
  private bindReadEffects(state: TenantState) {
    bindEffects(state, {
      mode: this.opts.mode,
      sim: this.opts.sim,
      enqueue: () => {
        throw new Error("Cannot enqueue jobs from a read");
      },
      afterCommit: () => {
        throw new Error("Cannot register afterCommit from a read");
      },
      q: null,
    });
  }

  private async orgRow(q: Queryable, orgId: string, lock: boolean): Promise<OrgRow> {
    const { rows } = await q.query<OrgRow>(
      `SELECT rev, data FROM organizations WHERE id = $1${lock ? " FOR UPDATE" : ""}`,
      [orgId],
    );
    if (!rows[0]) throw new HttpError(404, "Workspace not found");
    return rows[0];
  }

  private keyOf(collection: RecordCollection, entity: object): string {
    const known = this.keys.get(entity);
    if (known) return known;
    const spec = RECORD_COLLECTIONS[collection] as { key?: (e: never) => string };
    const id = (entity as { id?: unknown }).id;
    const key = spec.key ? spec.key(entity as never) : typeof id === "string" ? id : newId("rec");
    this.keys.set(entity, key);
    return key;
  }

  private cloneState(state: TenantState): TenantState {
    const draft = {} as Record<string, unknown[]>;
    for (const [name, items] of Object.entries(state) as [string, object[]][]) {
      draft[name] = items.map((item) => {
        const copy = structuredClone(item);
        const key = this.keys.get(item);
        if (key) this.keys.set(copy, key);
        return copy;
      });
    }
    return draft as unknown as TenantState;
  }

  private put(orgId: string, cached: Cached) {
    const current = this.cache.get(orgId);
    if (current && current.rev > cached.rev) return;
    if (this.opts.freeze) deepFreeze(cached.state);
    this.cache.delete(orgId);
    this.cache.set(orgId, cached);
    while (this.cache.size > this.opts.cacheSize) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
  }

  private async sync(orgId: string, q: Queryable, row: OrgRow): Promise<Cached> {
    const cached = this.cache.get(orgId);
    if (cached && cached.rev === row.rev) {
      // Touch for LRU.
      this.cache.delete(orgId);
      this.cache.set(orgId, cached);
      return cached;
    }
    const incremental =
      !!cached && cached.rev < row.rev && Date.now() - cached.syncedAt < MAX_INCREMENTAL_AGE_MS;
    this.metrics.tenantLoads.inc({ kind: incremental ? "incremental" : "full" });

    const entries = {} as Cached["entries"];
    const touched = new Set<RecordCollection>();
    for (const name of RECORD_COLLECTION_NAMES)
      entries[name] = incremental ? cached!.entries[name] : new Map();

    const { rows } = await q.query<RecordRow>(
      incremental
        ? `SELECT collection, id, data, seq, deleted FROM tenant_records WHERE org_id = $1 AND rev > $2 ORDER BY seq`
        : `SELECT collection, id, data, seq, deleted FROM tenant_records WHERE org_id = $1 AND NOT deleted ORDER BY seq`,
      incremental ? [orgId, cached!.rev] : [orgId],
    );
    for (const r of rows) {
      if (!(r.collection in RECORD_COLLECTIONS)) continue;
      if (!touched.has(r.collection)) {
        touched.add(r.collection);
        // Copy-on-write: snapshots already handed out must not change underneath their readers.
        if (incremental) entries[r.collection] = new Map(entries[r.collection]);
      }
      if (r.deleted) entries[r.collection].delete(r.id);
      else {
        this.keys.set(r.data, r.id);
        entries[r.collection].set(r.id, { obj: r.data, json: JSON.stringify(r.data), seq: r.seq });
      }
    }

    const state = emptyState();
    for (const name of RECORD_COLLECTION_NAMES) {
      if (incremental && !touched.has(name)) {
        (state[name] as unknown[]) = cached!.state[name] as unknown[];
        continue;
      }
      const list = [...entries[name].values()].sort((a, b) => a.seq - b.seq).map((e) => e.obj);
      if (RECORD_COLLECTIONS[name].order === "desc") list.reverse();
      (state[name] as unknown[]) = list;
    }
    const people = await q.query<{
      user_id: string;
      role: Role;
      joined_at: Date;
      removed_at: Date | null;
      name: string;
      email: string;
      title: string;
      github_login: string | null;
    }>(
      `SELECT m.user_id, m.role, m.joined_at, m.removed_at, u.name, u.email, u.title, u.github_login
       FROM memberships m JOIN users u ON u.id = m.user_id
       WHERE m.org_id = $1 ORDER BY m.joined_at, m.user_id`,
      [orgId],
    );
    state.users = people.rows.map((p) => toUser(p));
    state.memberships = people.rows
      .filter((p) => !p.removed_at)
      .map((p) => ({
        orgId,
        userId: p.user_id,
        role: p.role,
        joinedAt: isoSeconds(p.joined_at),
      }));
    state.organizations = [row.data];

    const next: Cached = {
      rev: row.rev,
      state,
      entries,
      orgJson: JSON.stringify(row.data),
      syncedAt: Date.now(),
    };
    this.put(orgId, next);
    return next;
  }

  private diff(orgId: string, cached: Cached, draft: TenantState) {
    const upserts: { c: RecordCollection; i: string; d: object; json: string }[] = [];
    const deletes: { c: RecordCollection; i: string }[] = [];
    const inserted: Partial<Record<RecordCollection, object[]>> = {};
    for (const name of RECORD_COLLECTION_NAMES) {
      const spec = RECORD_COLLECTIONS[name];
      const before = cached.entries[name];
      const seen = new Set<string>();
      const items = draft[name] as object[];
      const fresh: typeof upserts = [];
      for (const item of items) {
        const key = this.keyOf(name, item);
        if (seen.has(key)) throw new Error(`Duplicate ${name} key "${key}" in workspace ${orgId}`);
        seen.add(key);
        const json = JSON.stringify(item);
        const prev = before.get(key);
        if (prev && prev.json === json) continue;
        const parsed = spec.schema.safeParse(item);
        if (!parsed.success) {
          const issue = parsed.error.issues[0];
          throw new Error(
            `Refusing to store invalid ${name} "${key}": ${issue?.path.join(".")} ${issue?.message}`,
          );
        }
        if (prev) upserts.push({ c: name, i: key, d: item, json });
        else fresh.push({ c: name, i: key, d: item, json });
      }
      // New rows get ascending sequence numbers; a newest-first collection is written oldest-first.
      if (spec.order === "desc") fresh.reverse();
      if (fresh.length) inserted[name] = fresh.map((f) => f.d);
      upserts.push(...fresh);
      for (const key of before.keys()) if (!seen.has(key)) deletes.push({ c: name, i: key });
    }

    if (draft.organizations.length !== 1 || draft.organizations[0].id !== orgId)
      throw new Error("A workspace write may not add or remove organizations");
    const orgJson = JSON.stringify(draft.organizations[0]);
    const orgChanged = orgJson !== cached.orgJson;

    const beforeMembers = new Map(cached.state.memberships.map((m) => [m.userId, m]));
    const memberUpserts = draft.memberships.filter((m) => {
      const prev = beforeMembers.get(m.userId);
      return !prev || prev.role !== m.role;
    });
    const afterIds = new Set(draft.memberships.map((m) => m.userId));
    const memberRemovals = [...beforeMembers.keys()].filter((id) => !afterIds.has(id));

    return {
      upserts,
      deletes,
      inserted,
      orgChanged,
      orgJson,
      memberUpserts,
      memberRemovals,
      changed:
        upserts.length > 0 ||
        deletes.length > 0 ||
        orgChanged ||
        memberUpserts.length > 0 ||
        memberRemovals.length > 0,
    };
  }

  private async upsertRecords(
    q: Queryable,
    orgId: string,
    rev: number,
    rows: { c: string; i: string; d: unknown }[],
  ): Promise<Map<string, number>> {
    const seqs = new Map<string, number>();
    // Chunked so a large seed stays well under the protocol's parameter size limits.
    for (let i = 0; i < rows.length; i += 2_000) {
      const chunk = rows.slice(i, i + 2_000);
      const res = await q.query<{ collection: string; id: string; seq: number }>(
        `INSERT INTO tenant_records (org_id, collection, id, data, rev)
         SELECT $1, e.value->>'c', e.value->>'i', e.value->'d', $2
         FROM jsonb_array_elements($3::jsonb) WITH ORDINALITY AS e(value, ord)
         ORDER BY e.ord
         ON CONFLICT (org_id, collection, id)
         DO UPDATE SET data = EXCLUDED.data, rev = EXCLUDED.rev, deleted = false, updated_at = now()
         RETURNING collection, id, seq`,
        [orgId, rev, JSON.stringify(chunk)],
      );
      for (const r of res.rows) seqs.set(`${r.collection}\u0000${r.id}`, r.seq);
    }
    return seqs;
  }

  private async persist(
    q: Queryable,
    orgId: string,
    rev: number,
    cached: Cached,
    draft: TenantState,
    plan: ReturnType<TenantStore["diff"]>,
  ): Promise<Cached> {
    const seqs = await this.upsertRecords(q, orgId, rev, plan.upserts);
    if (plan.deletes.length)
      await q.query(
        `UPDATE tenant_records t SET deleted = true, rev = $2, updated_at = now()
         FROM jsonb_array_elements($3::jsonb) e
         WHERE t.org_id = $1 AND t.collection = e->>'c' AND t.id = e->>'i'`,
        [orgId, rev, JSON.stringify(plan.deletes)],
      );
    for (const m of plan.memberUpserts)
      await q.query(
        `INSERT INTO memberships (org_id, user_id, role, joined_at) VALUES ($1, $2, $3, $4)
         ON CONFLICT (org_id, user_id) DO UPDATE SET role = EXCLUDED.role, removed_at = NULL`,
        [orgId, m.userId, m.role, m.joinedAt],
      );
    if (plan.memberRemovals.length)
      await q.query(
        `UPDATE memberships SET removed_at = now() WHERE org_id = $1 AND user_id = ANY($2::text[])`,
        [orgId, plan.memberRemovals],
      );
    const org = draft.organizations[0];
    if (plan.orgChanged) OrganizationSchema.parse(org);
    await q.query(`UPDATE organizations SET rev = $2, data = $3::jsonb, slug = $4 WHERE id = $1`, [
      orgId,
      rev,
      plan.orgJson,
      org.slug,
    ]);

    // Rebuild the index around the draft's objects: they are the live snapshot from now on.
    const upserted = new Map(plan.upserts.map((u) => [`${u.c}\u0000${u.i}`, u]));
    const entries = {} as Cached["entries"];
    for (const name of RECORD_COLLECTION_NAMES) {
      const before = cached.entries[name];
      const map = new Map<string, Entry>();
      for (const item of draft[name] as object[]) {
        const key = this.keyOf(name, item);
        const ref = `${name}\u0000${key}`;
        const prev = before.get(key);
        map.set(key, {
          obj: item,
          json: upserted.get(ref)?.json ?? prev!.json,
          seq: seqs.get(ref) ?? prev?.seq ?? 0,
        });
      }
      entries[name] = map;
    }
    return { rev, state: draft, entries, orgJson: plan.orgJson, syncedAt: Date.now() };
  }
}

function toUser(p: {
  user_id: string;
  name: string;
  email: string;
  title: string;
  github_login: string | null;
}): User {
  return {
    id: p.user_id,
    name: p.name,
    email: p.email,
    title: p.title,
    ...(p.github_login ? { githubLogin: p.github_login } : {}),
  };
}

export function isoSeconds(d: Date | string): string {
  return new Date(d).toISOString().replace(/\.\d{3}Z$/, "Z");
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}
