import type { FastifyInstance } from "fastify";
import { createApp, type App, type AppOverrides } from "../src/app";
import { loadConfig } from "../src/config";
import { buildServer } from "../src/http/server";
import { openDatabase } from "../src/platform/db";
import { loadSeedFile } from "../src/demo/seed";
import type { MockDb } from "../src/contract/schemas";
import { randomId } from "../src/platform/ids";

let seedPromise: Promise<MockDb> | null = null;
export const demoSeed = () => (seedPromise ??= loadSeedFile("seed/demo-data.json"));

export interface Harness {
  app: App;
  server: FastifyInstance;
  client(): Client;
  close(): Promise<void>;
}

export interface Res<T = any> {
  status: number;
  body: T;
  headers: Record<string, unknown>;
}

/** A browser-like client: keeps cookies between requests. */
export class Client {
  cookies: Record<string, string> = {};
  bearer: string | null = null;
  constructor(
    private server: FastifyInstance,
    private prefix: string,
  ) {}

  async request<T = any>(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<Res<T>> {
    const res = await this.server.inject({
      method,
      url: this.prefix + path,
      headers: {
        ...(Object.keys(this.cookies).length
          ? {
              cookie: Object.entries(this.cookies)
                .map(([k, v]) => `${k}=${v}`)
                .join("; "),
            }
          : {}),
        ...(this.bearer ? { authorization: `Bearer ${this.bearer}` } : {}),
        ...(method === "POST" ? { "content-type": "application/json" } : {}),
        ...headers,
      },
      payload: method === "POST" ? JSON.stringify(body ?? {}) : undefined,
    });
    for (const c of res.cookies) {
      if (c.value === "" && (c.maxAge === 0 || (c.expires && c.expires.getTime() < Date.now())))
        delete this.cookies[c.name];
      else this.cookies[c.name] = c.value;
    }
    let parsed: unknown = res.body;
    try {
      parsed = JSON.parse(res.body);
    } catch {
      /* non-JSON */
    }
    return { status: res.statusCode, body: parsed as T, headers: res.headers };
  }
  get<T = any>(path: string) {
    return this.request<T>("GET", path);
  }
  post<T = any>(path: string, body?: unknown, headers?: Record<string, string>) {
    return this.request<T>("POST", path, body, headers);
  }
  async signInAs(userId: string, orgId?: string) {
    const res = await this.post("/session", { userId, orgId });
    if (res.status !== 200) throw new Error(`sign-in failed: ${JSON.stringify(res.body)}`);
    return res.body;
  }
}

export async function createHarness(
  env: Record<string, string> = {},
  overrides: AppOverrides = {},
): Promise<Harness> {
  const config = loadConfig({
    NODE_ENV: "test",
    LOG_LEVEL: "silent",
    DATABASE_URL: process.env.TEST_DATABASE_URL ?? "pglite://memory",
    ROLE: "api",
    DEMO_MODE: "true",
    RATE_LIMIT_PER_MINUTE: "100000",
    AUTH_RATE_LIMIT_PER_MINUTE: "100000",
    FP_SIM_RUN_MS: "40",
    FP_SIM_VERIFY_MS: "30",
    FP_SIM_SCAN_MS: "20",
    FP_SIM_INDEX_MS: "10",
    ...env,
  });
  // With TEST_DATABASE_URL (a real Postgres), every harness gets its own throwaway database.
  let dbUrl = config.databaseUrl;
  let dropDatabase = async () => {};
  if (!dbUrl.startsWith("pglite:")) {
    const admin = await openDatabase(dbUrl);
    const name = `fp_test_${randomId(10)}`;
    await admin.query(`CREATE DATABASE ${name}`);
    const url = new URL(dbUrl);
    url.pathname = `/${name}`;
    dbUrl = url.toString();
    dropDatabase = async () => {
      await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
      await admin.close();
    };
  }
  const db = await openDatabase(dbUrl);
  const app = await createApp(config, {
    db,
    seed: config.demoMode ? await demoSeed() : undefined,
    ...overrides,
  });
  const server = await buildServer(app);
  await server.ready();
  return {
    app,
    server,
    client: () => new Client(server, config.apiPrefix),
    close: async () => {
      await server.close();
      await app.close();
      await db.close();
      await dropDatabase();
    },
  };
}

/** Runs due background jobs until the queue is idle, waiting `ms` first for simulated work to become due. */
export async function settle(h: Harness, ms = 0, rounds = 6) {
  for (let i = 0; i < rounds; i++) {
    if (ms) await new Promise((r) => setTimeout(r, ms));
    await h.app.worker.drain();
  }
}

/** Polls (running due jobs in between) until `check` returns a truthy value. */
export async function waitFor<T>(
  h: Harness,
  check: () => Promise<T | false | null | undefined>,
  timeoutMs = 8000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    await h.app.worker.drain();
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 15));
  }
}
