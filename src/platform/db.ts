/**
 * Database access. Two drivers behind one small interface:
 *  - node-postgres for real deployments (pooled connections),
 *  - PGlite (Postgres compiled to WASM, in-process) for tests and zero-setup local runs.
 * Both speak the same SQL, so migrations and queries are identical.
 */
import pg from "pg";

export interface QueryResult<T> {
  rows: T[];
  rowCount: number;
}

export interface Queryable {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<QueryResult<T>>;
}

export interface Database extends Queryable {
  readonly driver: "postgres" | "pglite";
  /** Runs `fn` in one transaction; commits when it resolves, rolls back when it throws. */
  tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T>;
  /** LISTEN on a channel. Returns an unsubscribe function. */
  listen(channel: string, onMessage: (payload: string) => void): Promise<() => Promise<void>>;
  close(): Promise<void>;
}

// int8 and numeric arrive as strings by default; every bigint we store fits a double.
pg.types.setTypeParser(20, (v) => Number(v));

class PostgresDatabase implements Database {
  readonly driver = "postgres" as const;
  private pool: pg.Pool;
  private listener: pg.Client | null = null;
  private listeners = new Map<string, Set<(payload: string) => void>>();
  private closed = false;

  constructor(
    private url: string,
    poolSize: number,
    private onError: (err: Error) => void,
  ) {
    this.pool = new pg.Pool({ connectionString: url, max: poolSize, idleTimeoutMillis: 30_000 });
    this.pool.on("error", onError);
  }

  async query<T>(sql: string, params: unknown[] = []): Promise<QueryResult<T>> {
    const r = await this.pool.query(sql, params);
    return { rows: r.rows as T[], rowCount: r.rowCount ?? 0 };
  }

  async tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    const q: Queryable = {
      query: async <R>(sql: string, params: unknown[] = []) => {
        const r = await client.query(sql, params);
        return { rows: r.rows as R[], rowCount: r.rowCount ?? 0 };
      },
    };
    try {
      await client.query("BEGIN");
      const out = await fn(q);
      await client.query("COMMIT");
      return out;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  /** One dedicated connection carries every LISTEN; it reconnects with backoff if it drops. */
  private async ensureListener(): Promise<pg.Client> {
    if (this.listener) return this.listener;
    const client = new pg.Client({ connectionString: this.url });
    client.on("notification", (msg) => {
      this.listeners.get(msg.channel)?.forEach((cb) => cb(msg.payload ?? ""));
    });
    client.on("error", (err) => {
      this.onError(err);
      this.listener = null;
      if (!this.closed) setTimeout(() => void this.resubscribe(), 1_000).unref();
    });
    await client.connect();
    this.listener = client;
    return client;
  }

  private async resubscribe() {
    try {
      const client = await this.ensureListener();
      for (const channel of this.listeners.keys())
        await client.query(`LISTEN ${pg.escapeIdentifier(channel)}`);
    } catch (err) {
      this.onError(err as Error);
      if (!this.closed) setTimeout(() => void this.resubscribe(), 5_000).unref();
    }
  }

  async listen(channel: string, onMessage: (payload: string) => void) {
    const client = await this.ensureListener();
    if (!this.listeners.has(channel)) {
      this.listeners.set(channel, new Set());
      await client.query(`LISTEN ${pg.escapeIdentifier(channel)}`);
    }
    this.listeners.get(channel)!.add(onMessage);
    return async () => {
      this.listeners.get(channel)?.delete(onMessage);
    };
  }

  async close() {
    this.closed = true;
    await this.listener?.end().catch(() => undefined);
    await this.pool.end();
  }
}

type PGliteLike = {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; affectedRows?: number }>;
  exec: (sql: string) => Promise<unknown>;
  transaction: <T>(fn: (tx: PGliteLike) => Promise<T>) => Promise<T>;
  listen: (channel: string, cb: (payload: string) => void) => Promise<() => Promise<void>>;
  close: () => Promise<void>;
  waitReady: Promise<void>;
};

class PGliteDatabase implements Database {
  readonly driver = "pglite" as const;
  constructor(private db: PGliteLike) {}

  private static adapt(db: PGliteLike): Queryable {
    return {
      query: async <T>(sql: string, params: unknown[] = []) => {
        const r = await db.query(sql, params);
        return { rows: r.rows as T[], rowCount: r.affectedRows ?? r.rows.length };
      },
    };
  }

  query<T>(sql: string, params: unknown[] = []) {
    return PGliteDatabase.adapt(this.db).query<T>(sql, params);
  }

  tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T> {
    return this.db.transaction((tx) => fn(PGliteDatabase.adapt(tx)));
  }

  listen(channel: string, onMessage: (payload: string) => void) {
    return this.db.listen(channel, onMessage);
  }

  close() {
    return this.db.close();
  }
}

export async function openDatabase(
  url: string,
  opts: { poolSize?: number; onError?: (err: Error) => void } = {},
): Promise<Database> {
  if (url.startsWith("pglite://")) {
    const { PGlite } = await import("@electric-sql/pglite");
    const target = url.slice("pglite://".length);
    const db = new PGlite(target === "memory" || target === "" ? undefined : target, {
      // Return int8 as numbers, matching the node-postgres parser above.
      parsers: { 20: (v: string) => Number(v) },
    }) as unknown as PGliteLike;
    await db.waitReady;
    return new PGliteDatabase(db);
  }
  return new PostgresDatabase(url, opts.poolSize ?? 10, opts.onError ?? (() => undefined));
}
