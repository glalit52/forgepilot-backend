/**
 * Runtime configuration. Everything comes from the environment and is validated
 * once at boot, so a misconfigured deployment fails immediately with a readable
 * message instead of at the first request that needs the missing value.
 */
import { z } from "zod";

const bool = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === "" ? def : /^(1|true|yes|on)$/i.test(v)));
const int = (def: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === "" ? def : Number(v)))
    .pipe(z.number().finite());
const opt = z
  .string()
  .optional()
  .transform((v) => (v ? v : undefined));

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().default("0.0.0.0"),
  PORT: int(8080),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  /** all = API + workers in one process; split them in production. */
  ROLE: z.enum(["all", "api", "worker"]).default("all"),
  /** postgres://… for real deployments; pglite://memory or pglite://<dir> for zero-setup local runs. */
  DATABASE_URL: z.string().default("pglite://.data/pg"),
  DATABASE_POOL_SIZE: int(10),
  API_PREFIX: z.string().default("/api/v1"),
  /** Public URL of the web app (links in emails, OAuth redirects). */
  APP_URL: z.string().default("http://localhost:3000"),
  /** Public URL of this API including the prefix (OAuth callbacks, webhook URLs). */
  PUBLIC_API_URL: opt,
  CORS_ORIGINS: z.string().default(""),
  COOKIE_SECURE: bool(false),
  COOKIE_DOMAIN: opt,
  SESSION_TTL_DAYS: int(30),
  /** Demo mode: seeded fictional workspaces, persona sign-in and "reset demo data". Never enable with real customer data. */
  DEMO_MODE: bool(false),
  /** 32-byte key (base64 or hex) that encrypts integration credentials at rest. */
  VAULT_KEY: opt,
  RATE_LIMIT_PER_MINUTE: int(600),
  AUTH_RATE_LIMIT_PER_MINUTE: int(20),
  TENANT_CACHE_SIZE: int(200),

  /** simulated = deterministic stand-ins for agents, test workers and scans; live = real execution. */
  EXECUTION_MODE: z.enum(["simulated", "live"]).default("simulated"),
  FP_SIM_RUN_MS: int(12_000),
  FP_SIM_VERIFY_MS: int(8_000),
  FP_SIM_SCAN_MS: int(6_000),
  FP_SIM_INDEX_MS: int(4_000),
  WORKER_CONCURRENCY: int(4),
  WORKSPACE_ROOT: z.string().default("/tmp/forgepilot-workspaces"),
  /** process = run agent/test commands directly on the worker; docker = inside a throwaway container. */
  EXECUTION_SANDBOX: z.enum(["process", "docker"]).default("docker"),
  CLAUDE_CODE_BIN: z.string().default("claude"),
  CODEX_BIN: z.string().default("codex"),

  GITHUB_APP_ID: opt,
  GITHUB_APP_SLUG: opt,
  GITHUB_APP_PRIVATE_KEY: opt,
  GITHUB_WEBHOOK_SECRET: opt,
  GITHUB_OAUTH_CLIENT_ID: opt,
  GITHUB_OAUTH_CLIENT_SECRET: opt,
  GITHUB_API_URL: z.string().default("https://api.github.com"),

  STRIPE_SECRET_KEY: opt,
  STRIPE_WEBHOOK_SECRET: opt,
  /** JSON: {"developer":{"monthly":"price_…","annual":"price_…"}, …} */
  STRIPE_PRICES: opt,
  /** JSON: Stripe billing-meter event names per usage meter, e.g. {"agent_minutes":"fp_agent_minutes"} */
  STRIPE_METERS: opt,
  /** Comma-separated emails of ForgePilot staff allowed into the back-office (/admin). The email must be verified. */
  PLATFORM_ADMIN_EMAILS: z.string().default(""),

  /** Where execution artifacts (test output, later screenshots and traces) are kept. */
  ARTIFACT_STORE: z.enum(["local", "s3"]).default("local"),
  ARTIFACT_DIR: z.string().default(".data/artifacts"),
  S3_BUCKET: opt,
  S3_REGION: z.string().default("us-east-1"),
  /** For S3-compatible services such as Cloudflare R2 or MinIO. */
  S3_ENDPOINT: opt,

  RESEND_API_KEY: opt,
  EMAIL_FROM: z.string().default("ForgePilot <no-reply@forgepilot.dev>"),
});

export type Config = ReturnType<typeof loadConfig>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`);
    throw new Error(`Invalid configuration:\n${lines.join("\n")}`);
  }
  const e = parsed.data;
  const production = e.NODE_ENV === "production";
  const problems: string[] = [];
  if (production && !e.VAULT_KEY) problems.push("VAULT_KEY is required in production");
  if (
    production &&
    e.DEMO_MODE &&
    !/^pglite:/.test(e.DATABASE_URL) &&
    !env.ALLOW_DEMO_IN_PRODUCTION
  )
    problems.push(
      "DEMO_MODE with a real database in production needs ALLOW_DEMO_IN_PRODUCTION=1 (demo sign-in has no passwords)",
    );
  if (production && !e.COOKIE_SECURE) problems.push("COOKIE_SECURE must be true in production");
  if (e.EXECUTION_MODE === "live" && !(e.GITHUB_APP_ID && e.GITHUB_APP_PRIVATE_KEY))
    problems.push("EXECUTION_MODE=live needs GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY");
  let stripePrices: Record<string, { monthly?: string; annual?: string }> = {};
  if (e.STRIPE_PRICES) {
    try {
      stripePrices = JSON.parse(e.STRIPE_PRICES);
    } catch {
      problems.push("STRIPE_PRICES must be JSON");
    }
  }
  if (e.ARTIFACT_STORE === "s3" && !e.S3_BUCKET) problems.push("ARTIFACT_STORE=s3 needs S3_BUCKET");
  let stripeMeters: Record<string, string> = {};
  if (e.STRIPE_METERS) {
    try {
      stripeMeters = JSON.parse(e.STRIPE_METERS);
    } catch {
      problems.push("STRIPE_METERS must be JSON");
    }
  }
  if (problems.length) throw new Error(`Invalid configuration:\n  ${problems.join("\n  ")}`);

  return {
    env: e.NODE_ENV,
    production,
    host: e.HOST,
    port: e.PORT,
    logLevel: e.LOG_LEVEL,
    role: e.ROLE,
    databaseUrl: e.DATABASE_URL,
    databasePoolSize: e.DATABASE_POOL_SIZE,
    apiPrefix: e.API_PREFIX.replace(/\/$/, ""),
    appUrl: e.APP_URL.replace(/\/$/, ""),
    publicApiUrl: (e.PUBLIC_API_URL ?? `http://localhost:${e.PORT}${e.API_PREFIX}`).replace(
      /\/$/,
      "",
    ),
    corsOrigins: e.CORS_ORIGINS.split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    cookie: { secure: e.COOKIE_SECURE, domain: e.COOKIE_DOMAIN, ttlDays: e.SESSION_TTL_DAYS },
    demoMode: e.DEMO_MODE,
    vaultKey: e.VAULT_KEY,
    rateLimit: { perMinute: e.RATE_LIMIT_PER_MINUTE, authPerMinute: e.AUTH_RATE_LIMIT_PER_MINUTE },
    tenantCacheSize: e.TENANT_CACHE_SIZE,
    execution: {
      mode: e.EXECUTION_MODE,
      sim: {
        runMs: e.FP_SIM_RUN_MS,
        verifyMs: e.FP_SIM_VERIFY_MS,
        scanMs: e.FP_SIM_SCAN_MS,
        indexMs: e.FP_SIM_INDEX_MS,
      },
      concurrency: e.WORKER_CONCURRENCY,
      workspaceRoot: e.WORKSPACE_ROOT,
      sandbox: e.EXECUTION_SANDBOX,
      claudeBin: e.CLAUDE_CODE_BIN,
      codexBin: e.CODEX_BIN,
    },
    github: {
      appId: e.GITHUB_APP_ID,
      appSlug: e.GITHUB_APP_SLUG,
      privateKey: e.GITHUB_APP_PRIVATE_KEY?.replace(/\\n/g, "\n"),
      webhookSecret: e.GITHUB_WEBHOOK_SECRET,
      oauthClientId: e.GITHUB_OAUTH_CLIENT_ID,
      oauthClientSecret: e.GITHUB_OAUTH_CLIENT_SECRET,
      apiUrl: e.GITHUB_API_URL.replace(/\/$/, ""),
    },
    stripe: {
      secretKey: e.STRIPE_SECRET_KEY,
      webhookSecret: e.STRIPE_WEBHOOK_SECRET,
      prices: stripePrices,
      meters: stripeMeters,
    },
    platformAdmins: e.PLATFORM_ADMIN_EMAILS.split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
    artifacts: {
      driver: e.ARTIFACT_STORE,
      dir: e.ARTIFACT_DIR,
      s3: { bucket: e.S3_BUCKET ?? "", region: e.S3_REGION, endpoint: e.S3_ENDPOINT },
    },
    email: { resendApiKey: e.RESEND_API_KEY, from: e.EMAIL_FROM },
  };
}
