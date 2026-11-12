/**
 * Composition root: builds every service from configuration and wires the
 * ports the domain depends on. Nothing else constructs infrastructure, which
 * keeps tests able to swap the database, clock-free seams and `fetch`.
 */
import type Stripe from "stripe";
import type { Config } from "./config";
import { AdvisoryClient } from "./connectors/advisories";
import { CredentialStore } from "./connectors/credentials";
import { GithubApp } from "./connectors/github";
import type { FetchLike } from "./connectors/http";
import { IssueTrackers } from "./connectors/issueTrackers";
import { ChatNotifier, Mailer } from "./connectors/messaging";
import { OutboundWebhooks } from "./connectors/outboundWebhooks";
import { StripeBilling } from "./connectors/stripe";
import type { MockDb } from "./contract/schemas";
import { demoSeeded, loadSeedFile, resetDemo, seedDemo } from "./demo/seed";
import type { DomainPorts } from "./domain/context";
import { Engine, RouteTable, scheduleAdvance } from "./domain/engine";
import { extraRoutes } from "./domain/extraRoutes";
import { advance, startScan } from "./domain/loop";
import { routes as contractRoutes } from "./domain/routes";
import { ExecutionPlane, type RepoAccess } from "./execution/plane";
import { RepoIntel } from "./execution/repoIntel";
import { IdentityService } from "./identity/service";
import { Fanout } from "./integrations/fanout";
import { GithubEvents, GithubRepoAccess } from "./integrations/github";
import { Maintenance } from "./integrations/maintenance";
import { StripeEvents } from "./integrations/stripeEvents";
import { ChangeBus } from "./platform/bus";
import { Vault } from "./platform/crypto";
import { openDatabase, type Database } from "./platform/db";
import { HttpError } from "./platform/errors";
import { enqueueJob, JobWorker, type JobInput } from "./platform/jobs";
import { createLogger, type Logger } from "./platform/logger";
import { Metrics } from "./platform/metrics";
import { migrate } from "./platform/migrations";
import { TenantStore } from "./tenancy/store";

export interface AppOverrides {
  db?: Database;
  fetch?: FetchLike;
  log?: Logger;
  /** Replaces GitHub-backed repository access (tests use a local git remote). */
  repos?: (defaults: RepoAccess) => RepoAccess;
  seed?: MockDb;
  resolveHost?: (host: string) => Promise<string[]>;
  /** A Stripe client to use instead of one built from STRIPE_SECRET_KEY. */
  stripe?: Stripe;
}

export interface App {
  config: Config;
  log: Logger;
  db: Database;
  metrics: Metrics;
  bus: ChangeBus;
  store: TenantStore;
  identity: IdentityService;
  engine: Engine;
  tenantRoutes: RouteTable;
  worker: JobWorker;
  github: GithubApp;
  githubEvents: GithubEvents;
  billing: StripeBilling;
  stripeEvents: StripeEvents;
  credentials: CredentialStore;
  mailer: Mailer;
  plane: ExecutionPlane;
  maintenance: Maintenance;
  enqueue(job: JobInput): Promise<void>;
  resetDemo(): Promise<void>;
  close(): Promise<void>;
}

const MAINTENANCE_KEY = "maintenance.tick";

export async function createApp(config: Config, overrides: AppOverrides = {}): Promise<App> {
  const log = overrides.log ?? createLogger(config.logLevel);
  const fetchImpl = overrides.fetch ?? fetch;
  const db =
    overrides.db ??
    (await openDatabase(config.databaseUrl, {
      poolSize: config.databasePoolSize,
      onError: (err) => log.error({ err }, "database connection error"),
    }));
  const applied = await migrate(db);
  if (applied.length) log.info({ applied }, "migrations applied");

  const metrics = new Metrics();
  const bus = new ChangeBus();
  await bus.attach(db);
  const store = new TenantStore(db, bus, log, metrics, {
    mode: config.execution.mode,
    sim: config.execution.sim,
    cacheSize: config.tenantCacheSize,
    freeze: !config.production,
  });
  const vault = new Vault(config.vaultKey, { allowEphemeral: !config.production });
  const identity = new IdentityService(db, {
    sessionTtlDays: config.cookie.ttlDays,
    demoMode: config.demoMode,
    platformAdmins: config.platformAdmins,
  });
  const github = new GithubApp(config.github, fetchImpl, db);
  const credentials = new CredentialStore(db, vault, fetchImpl);
  const billing = new StripeBilling(config.stripe, db, config.appUrl, overrides.stripe);
  const mailer = new Mailer(config.email, fetchImpl, log);
  const webhooks = new OutboundWebhooks(db, vault, fetchImpl, overrides.resolveHost);
  const trackers = new IssueTrackers(fetchImpl);
  const githubRepos = new GithubRepoAccess(
    github,
    new RepoIntel(github, new AdvisoryClient(fetchImpl)),
  );
  const repos = overrides.repos ? overrides.repos(githubRepos) : githubRepos;
  const plane = new ExecutionPlane({ config, db, store, repos, credentials, log });
  const githubLive = github.configured;

  const ports: DomainPorts = {
    demoMode: config.demoMode,
    githubLive,
    stripeLive: billing.configured,
    appUrl: config.appUrl,
    executionLive: config.execution.mode === "live",
    personas: () => identity.personas(),
    runs: { workerLog: (orgId, runId) => plane.runLog(orgId, runId) },
    webhooks: {
      list: (orgId) => webhooks.list(orgId),
      create: (orgId, userId, input) => webhooks.create(orgId, userId, input),
      remove: (orgId, id) => webhooks.remove(orgId, id),
    },
    externalIssues: {
      list: async (orgId, providerId) => {
        const secret = await credentials.get(orgId, providerId);
        if (!secret)
          throw new HttpError(409, `Reconnect ${providerId} with credentials to list its issues`);
        return trackers.list(providerId, secret);
      },
    },
    github: {
      listRepositories: async (orgId) =>
        (await github.listRepositories(orgId)).map((r) => ({
          fullName: r.full_name,
          private: r.private,
          language: r.language ?? "",
          defaultBranch: r.default_branch,
          pushedAt: r.pushed_at ?? "",
        })),
      resolveInstallation: (id) => github.getInstallation(id),
      linkInstallation: (q, orgId, id, account) => github.linkInstallation(q, orgId, id, account),
      unlinkInstallations: async (q, orgId) => {
        if (githubLive) await github.unlinkInstallations(q, orgId);
      },
      describeRepository: async (orgId, fullName) => {
        const installationId = await github.installationFor(orgId, fullName);
        const repo = await github.getRepository(installationId, fullName);
        return {
          url: repo.html_url,
          defaultBranch: repo.default_branch,
          private: repo.private,
          headSha: await github.branchHead(installationId, fullName, repo.default_branch),
        };
      },
      linkRepository: (q, orgId, repositoryId, fullName) =>
        github.linkRepository(q, orgId, repositoryId, fullName),
      pullRequestDiff: async (orgId, fullName, number) =>
        github.pullFiles(await github.installationFor(orgId, fullName), fullName, number),
    },
    credentials: {
      put: (q, orgId, providerId, secret) => credentials.put(q, orgId, providerId, secret),
      remove: (q, orgId, providerId) => credentials.remove(q, orgId, providerId),
      verify: (providerId, secret) => credentials.verify(providerId, secret),
    },
    apiKeys: {
      register: (q, input) => identity.registerApiKey(q, input),
      revoke: (q, orgId, keyId) => identity.revokeApiKey(q, orgId, keyId),
    },
    invitations: {
      issue: async (q, input) =>
        `${config.appUrl}/signup?invitation=${await identity.issueInvitation(q, input)}`,
      revoke: (q, orgId, invitationId) => identity.revokeInvitation(q, orgId, invitationId),
    },
    sessions: {
      log: (orgId, sessionId) => plane.sessionLog(orgId, sessionId),
      diff: (orgId, sessionId) => plane.sessionDiff(orgId, sessionId),
    },
    billing: {
      paymentMethod: (orgId) => billing.paymentMethod(orgId),
      portalUrl: (orgId) => billing.portalUrl(orgId),
      changePlan: (input) => billing.changePlan(input),
    },
  };

  const tenantRoutes = new RouteTable([
    ...contractRoutes.map((r) => ({ ...r, contract: true })),
    ...extraRoutes,
  ]);
  const engine = new Engine(store, ports, log, { strictResponses: !config.production });

  // ---------------------------------------------------------------- background work
  const worker = new JobWorker(db, log, metrics, { concurrency: config.execution.concurrency });
  const githubEvents = new GithubEvents({ db, store, github, log });
  const stripeEvents = new StripeEvents({ db, store, billing });
  const fanout = new Fanout({
    db,
    store,
    webhooks,
    chat: new ChatNotifier(fetchImpl),
    credentials,
    appUrl: config.appUrl,
  });

  worker.register("tenant.advance", async (job) => {
    await store.write(job.orgId!, (draft, effects) => {
      advance(draft, Date.now());
      // Reschedule even when nothing changed yet (the job may have fired a moment early).
      scheduleAdvance(draft, effects);
    });
  });
  worker.register("events.fanout", (job) => fanout.dispatch(job));
  worker.register("webhook.deliver", (job) => fanout.deliverWebhook(job));
  worker.register("chat.notify", (job) => fanout.notifyChat(job));
  worker.register("email.send", (job) =>
    mailer.send(
      String(job.payload.to),
      String(job.payload.template),
      job.payload.data as Record<string, string>,
    ),
  );
  worker.register("session.run", (job, { signal }) => plane.runSession(job, signal));
  worker.register("session.cleanup", (job) => plane.cleanupSession(job));
  worker.register("testrun.execute", (job, { signal }) => plane.executeTestRun(job, signal));
  worker.register("scan.execute", (job) => plane.executeScan(job));
  worker.register("repo.index", async (job) => {
    await plane.indexRepository(job);
    if (githubLive)
      await enqueueJob(db, { kind: "github.issues.sync", orgId: job.orgId, payload: job.payload });
  });
  worker.register("github.issues.sync", (job) => githubEvents.syncIssues(job));
  worker.register("github.webhook", (job) => githubEvents.process(job));
  worker.register("stripe.webhook", (job) => stripeEvents.process(job));
  const maintenance = new Maintenance({ db, store, billing, log });
  worker.register(MAINTENANCE_KEY, async () => {
    await identity.purgeExpired();
    // Once a day, in the quiet hours: retention and yesterday's metered usage.
    if (new Date().getUTCHours() === 3) {
      await maintenance.applyRetention();
      await maintenance.reportUsage();
    }
    await db.query(
      `DELETE FROM jobs WHERE status IN ('done','failed') AND finished_at < now() - interval '7 days'`,
    );
    await db.query(`DELETE FROM idempotency_keys WHERE created_at < now() - interval '2 days'`);
    await db.query(`DELETE FROM webhook_deliveries WHERE received_at < now() - interval '30 days'`);
    await db.query(
      `DELETE FROM tenant_records WHERE deleted AND updated_at < now() - interval '7 days'`,
    );
    // Scheduled CodeKeeper scans: daily and weekly repositories that are due.
    if (config.execution.mode === "live") {
      const { rows } = await db.query<{ id: string }>(
        `SELECT id FROM organizations WHERE NOT is_demo`,
      );
      for (const { id } of rows)
        await store.write(id, (draft) => {
          const now = Date.now();
          for (const repo of draft.repositories) {
            if (repo.indexStatus !== "ready" || !["daily", "weekly"].includes(repo.scanSchedule))
              continue;
            const last = draft.scans.find((s) => s.repositoryId === repo.id);
            const every = repo.scanSchedule === "daily" ? 86_400_000 : 7 * 86_400_000;
            if (last?.status === "running" || (last && now - Date.parse(last.startedAt) < every))
              continue;
            startScan(draft, repo, "schedule", now);
          }
        });
    }
    await enqueueJob(db, {
      kind: MAINTENANCE_KEY,
      dedupeKey: MAINTENANCE_KEY,
      runAt: new Date(Date.now() + 3_600_000),
    });
  });

  let seedCache: MockDb | null = overrides.seed ?? null;
  const seed = async () =>
    (seedCache ??= await loadSeedFile(process.env.DEMO_SEED_PATH ?? "seed/demo-data.json"));
  if (config.demoMode && !(await demoSeeded(db))) {
    await seedDemo(db, store, await seed(), { now: Date.now(), sim: config.execution.sim });
    log.info("demo data seeded");
  }
  await enqueueJob(db, {
    kind: MAINTENANCE_KEY,
    dedupeKey: MAINTENANCE_KEY,
    runAt: new Date(Date.now() + 60_000),
  });
  if (config.role !== "api") worker.start();

  return {
    config,
    log,
    db,
    metrics,
    bus,
    store,
    identity,
    engine,
    tenantRoutes,
    worker,
    github,
    githubEvents,
    billing,
    stripeEvents,
    credentials,
    mailer,
    plane,
    maintenance,
    enqueue: (job) => enqueueJob(db, job),
    resetDemo: async () =>
      resetDemo(db, store, await seed(), { now: Date.now(), sim: config.execution.sim }),
    close: async () => {
      await worker.stop();
      await bus.close();
      if (!overrides.db) await db.close();
    },
  };
}
