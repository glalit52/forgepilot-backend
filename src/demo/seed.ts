/**
 * Demo data. The fictional workspaces the web app was designed against are
 * loaded into the real store, so a demo deployment exercises exactly the same
 * code paths as production. Only ever touches rows flagged `is_demo`.
 */
import { readFile } from "node:fs/promises";
import { MockDbSchema, type MockDb } from "../contract/schemas";
import { nextDueAt, prepareSimulation } from "../domain/loop";
import type { Database } from "../platform/db";
import { toIso } from "../platform/ids";
import { enqueueJob } from "../platform/jobs";
import {
  emptyState,
  bindEffects,
  RECORD_COLLECTION_NAMES,
  type Effects,
  type TenantState,
} from "../tenancy/state";
import type { TenantStore } from "../tenancy/store";

const DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

/**
 * Shifts every timestamp so the demo story always happens "now": pending
 * approvals, running work and usage would otherwise drift into the past.
 * Datetimes move by the exact offset; calendar dates move by whole days.
 */
export function shiftSeedTimes<T extends { meta: { generatedAt: string } }>(
  raw: T,
  now: number,
): T {
  const offset = now - Date.parse(raw.meta.generatedAt);
  const dayOffset = Math.round(offset / DAY_MS) * DAY_MS;
  if (Math.abs(offset) < 60_000) return structuredClone(raw);
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") {
      if (DATETIME.test(v)) return toIso(Date.parse(v) + offset);
      if (DATE.test(v)) return toIso(Date.parse(v + "T00:00:00Z") + dayOffset).slice(0, 10);
      return v;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object")
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return walk(raw) as T;
}

/** Splits the multi-workspace seed into one state per workspace. */
export function partitionSeed(seed: MockDb): Map<string, TenantState> {
  const repoOrg = new Map(seed.repositories.map((r) => [r.id, r.orgId]));
  const runOrg = new Map(seed.testRuns.map((r) => [r.id, r.orgId]));
  const orgOf = (name: string, item: Record<string, unknown>): string | undefined => {
    if (typeof item.orgId === "string") return item.orgId;
    if (name === "healthHistory") return repoOrg.get(item.repositoryId as string);
    if (name === "testResults") return runOrg.get(item.runId as string);
    return undefined;
  };
  const states = new Map<string, TenantState>();
  for (const org of seed.organizations) {
    const state = emptyState();
    state.organizations = [org];
    states.set(org.id, state);
  }
  for (const name of RECORD_COLLECTION_NAMES)
    for (const item of seed[name] as unknown as Record<string, unknown>[]) {
      const orgId = orgOf(name, item);
      const state = orgId ? states.get(orgId) : undefined;
      if (!state) throw new Error(`Seed ${name} entry has no workspace`);
      (state[name] as unknown[]).push(item);
    }
  return states;
}

export async function loadSeedFile(path: string): Promise<MockDb> {
  return MockDbSchema.parse(JSON.parse(await readFile(path, "utf8")));
}

export async function demoSeeded(db: Database): Promise<boolean> {
  const { rows } = await db.query(`SELECT 1 FROM organizations WHERE is_demo LIMIT 1`);
  return rows.length > 0;
}

export async function seedDemo(
  db: Database,
  store: TenantStore,
  rawSeed: MockDb,
  opts: { now: number; sim: Effects["sim"] },
): Promise<void> {
  const seed = shiftSeedTimes(rawSeed, opts.now);
  const states = partitionSeed(seed);
  await db.tx(async (q) => {
    for (const u of seed.users)
      await q.query(
        `INSERT INTO users (id, email, name, title, github_login, is_demo, email_verified_at)
         VALUES ($1, $2, $3, $4, $5, true, now())
         ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, title = EXCLUDED.title`,
        [u.id, u.email, u.name, u.title, u.githubLogin ?? null],
      );
    for (const [orgId, state] of states) {
      // Loop helpers read timings through the state's effects; seeding has no jobs to enqueue yet.
      bindEffects(state, {
        mode: "simulated",
        sim: opts.sim,
        enqueue: () => undefined,
        afterCommit: () => undefined,
        q,
      });
      prepareSimulation(state, opts.now);
      await store.createOrganization(q, state.organizations[0], state, { isDemo: true });
      for (const m of seed.memberships.filter((x) => x.orgId === orgId))
        await q.query(
          `INSERT INTO memberships (org_id, user_id, role, joined_at) VALUES ($1, $2, $3, $4)`,
          [orgId, m.userId, m.role, m.joinedAt],
        );
      const due = nextDueAt(state);
      if (due !== null)
        await enqueueJob(q, {
          kind: "tenant.advance",
          orgId,
          runAt: new Date(due),
          dedupeKey: `tenant.advance:${orgId}`,
        });
    }
  });
}

/** Restores the demo to its starting story. Sessions of demo personas stay valid. */
export async function resetDemo(
  db: Database,
  store: TenantStore,
  rawSeed: MockDb,
  opts: { now: number; sim: Effects["sim"] },
): Promise<void> {
  const seedUserIds = rawSeed.users.map((u) => u.id);
  await db.tx(async (q) => {
    await q.query(
      `DELETE FROM jobs WHERE org_id IN (SELECT id FROM organizations WHERE is_demo) AND status = 'queued'`,
    );
    await q.query(`DELETE FROM organizations WHERE is_demo`);
    await q.query(`DELETE FROM users WHERE is_demo AND NOT (id = ANY($1::text[]))`, [seedUserIds]);
  });
  store.invalidate();
  await seedDemo(db, store, rawSeed, opts);
}
