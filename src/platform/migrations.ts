/**
 * Schema migrations, embedded so the bundled server carries them. Append-only:
 * never edit a released migration, add a new one.
 *
 * Storage model
 *  - Identity, access, jobs, webhooks, credentials and logs are ordinary relational tables.
 *  - Workspace-owned product entities (tasks, runs, findings…) live in `tenant_records`:
 *    one row per entity, keyed by (org_id, collection, id), with the entity as JSONB that
 *    is validated against the shared Zod contract. `rev` is the workspace revision that
 *    last touched the row, which is what makes cheap incremental cache refresh possible.
 */
import type { Database } from "./db";

export const MIGRATIONS: { id: string; sql: string }[] = [
  {
    id: "0001_init",
    sql: `
CREATE TABLE users (
  id                text PRIMARY KEY,
  email             text NOT NULL,
  email_lower       text GENERATED ALWAYS AS (lower(email)) STORED,
  name              text NOT NULL,
  title             text NOT NULL DEFAULT '',
  github_login      text,
  password_hash     text,
  email_verified_at timestamptz,
  is_demo           boolean NOT NULL DEFAULT false,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_lower_key ON users (email_lower);

CREATE TABLE identities (
  provider         text NOT NULL,
  provider_user_id text NOT NULL,
  user_id          text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, provider_user_id)
);
CREATE INDEX identities_user_idx ON identities (user_id);

CREATE TABLE auth_sessions (
  token_hash   text PRIMARY KEY,
  user_id      text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  ip           text,
  user_agent   text
);
CREATE INDEX auth_sessions_user_idx ON auth_sessions (user_id);
CREATE INDEX auth_sessions_expiry_idx ON auth_sessions (expires_at);

CREATE TABLE password_resets (
  token_hash text PRIMARY KEY,
  user_id    text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  used_at    timestamptz
);

CREATE TABLE organizations (
  id                     text PRIMARY KEY,
  slug                   text NOT NULL UNIQUE,
  data                   jsonb NOT NULL,
  rev                    bigint NOT NULL DEFAULT 1,
  is_demo                boolean NOT NULL DEFAULT false,
  stripe_customer_id     text UNIQUE,
  stripe_subscription_id text UNIQUE,
  created_at             timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE memberships (
  org_id     text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id    text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role       text NOT NULL CHECK (role IN ('owner','admin','member','viewer')),
  joined_at  timestamptz NOT NULL DEFAULT now(),
  -- Soft delete: former members stay resolvable in audit history.
  removed_at timestamptz,
  PRIMARY KEY (org_id, user_id)
);
CREATE INDEX memberships_user_idx ON memberships (user_id) WHERE removed_at IS NULL;

CREATE TABLE invitation_tokens (
  token_hash    text PRIMARY KEY,
  org_id        text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  invitation_id text NOT NULL,
  email         text NOT NULL,
  expires_at    timestamptz NOT NULL
);
CREATE INDEX invitation_tokens_inv_idx ON invitation_tokens (org_id, invitation_id);

CREATE TABLE tenant_records (
  org_id     text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  collection text NOT NULL,
  id         text NOT NULL,
  data       jsonb NOT NULL,
  rev        bigint NOT NULL,
  seq        bigserial,
  deleted    boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, collection, id)
);
CREATE INDEX tenant_records_rev_idx ON tenant_records (org_id, rev);
CREATE INDEX tenant_records_tombstone_idx ON tenant_records (updated_at) WHERE deleted;

CREATE TABLE api_key_secrets (
  token_hash text PRIMARY KEY,
  org_id     text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  key_id     text NOT NULL,
  created_by text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, key_id)
);

CREATE TABLE credentials (
  org_id      text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  provider_id text NOT NULL,
  ciphertext  text NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, provider_id)
);

CREATE TABLE github_installations (
  installation_id bigint PRIMARY KEY,
  org_id          text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  account_login   text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX github_installations_org_idx ON github_installations (org_id);

-- Maps a provider repository to the workspace record it belongs to, so webhooks can be routed.
CREATE TABLE repository_links (
  provider        text NOT NULL,
  full_name_lower text NOT NULL,
  org_id          text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  repository_id   text NOT NULL,
  installation_id bigint,
  PRIMARY KEY (provider, full_name_lower, org_id)
);

CREATE TABLE webhook_deliveries (
  provider     text NOT NULL,
  delivery_id  text NOT NULL,
  event        text NOT NULL,
  received_at  timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  status       text NOT NULL DEFAULT 'received',
  error        text,
  payload      jsonb NOT NULL,
  PRIMARY KEY (provider, delivery_id)
);
CREATE INDEX webhook_deliveries_received_idx ON webhook_deliveries (received_at);

CREATE TABLE jobs (
  id           bigserial PRIMARY KEY,
  kind         text NOT NULL,
  org_id       text,
  payload      jsonb NOT NULL DEFAULT '{}'::jsonb,
  status       text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','done','failed')),
  run_at       timestamptz NOT NULL DEFAULT now(),
  attempts     int NOT NULL DEFAULT 0,
  max_attempts int NOT NULL DEFAULT 5,
  dedupe_key   text,
  locked_by    text,
  locked_at    timestamptz,
  last_error   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz
);
CREATE INDEX jobs_ready_idx ON jobs (run_at, id) WHERE status = 'queued';
CREATE UNIQUE INDEX jobs_dedupe_idx ON jobs (dedupe_key) WHERE status = 'queued' AND dedupe_key IS NOT NULL;
CREATE INDEX jobs_running_idx ON jobs (locked_at) WHERE status = 'running';

CREATE TABLE session_log_lines (
  org_id     text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  session_id text NOT NULL,
  seq        int NOT NULL,
  at         timestamptz NOT NULL DEFAULT now(),
  level      text NOT NULL,
  text       text NOT NULL,
  PRIMARY KEY (org_id, session_id, seq)
);

CREATE TABLE artifacts (
  org_id     text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  kind       text NOT NULL,
  ref_id     text NOT NULL,
  data       jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, kind, ref_id)
);

CREATE TABLE idempotency_keys (
  scope        text NOT NULL,
  key          text NOT NULL,
  request_hash text NOT NULL,
  status       int,
  response     jsonb,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (scope, key)
);
CREATE INDEX idempotency_created_idx ON idempotency_keys (created_at);

CREATE TABLE webhook_endpoints (
  id         text PRIMARY KEY,
  org_id     text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  url        text NOT NULL,
  secret_ct  text NOT NULL,
  events     text[] NOT NULL DEFAULT '{}',
  enabled    boolean NOT NULL DEFAULT true,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX webhook_endpoints_org_idx ON webhook_endpoints (org_id);
`,
  },
  {
    id: "0002_staff_suspension_usage",
    sql: `
ALTER TABLE organizations ADD COLUMN suspended_at timestamptz;
ALTER TABLE organizations ADD COLUMN suspended_reason text;

CREATE TABLE email_verifications (
  token_hash text PRIMARY KEY,
  user_id    text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL
);

-- Everything ForgePilot staff do through the back-office, kept apart from customer audit logs.
CREATE TABLE staff_audit (
  id      bigserial PRIMARY KEY,
  user_id text NOT NULL,
  action  text NOT NULL,
  target  text NOT NULL,
  detail  text NOT NULL DEFAULT '',
  ip      text,
  at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX staff_audit_at_idx ON staff_audit (at);

-- Metered usage already sent to the billing provider, one row per workspace, meter and day.
CREATE TABLE usage_reports (
  org_id      text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  meter       text NOT NULL,
  day         date NOT NULL,
  units       double precision NOT NULL,
  reported_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, meter, day)
);
`,
  },
];

export async function migrate(db: Database): Promise<string[]> {
  await db.query(
    `CREATE TABLE IF NOT EXISTS schema_migrations (id text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`,
  );
  const applied: string[] = [];
  for (const m of MIGRATIONS) {
    await db.tx(async (q) => {
      // Serialise concurrent boots: only one instance applies a migration.
      await q.query(`LOCK TABLE schema_migrations IN EXCLUSIVE MODE`);
      const done = await q.query(`SELECT 1 FROM schema_migrations WHERE id = $1`, [m.id]);
      if (done.rows.length) return;
      for (const statement of splitStatements(m.sql)) await q.query(statement);
      await q.query(`INSERT INTO schema_migrations (id) VALUES ($1)`, [m.id]);
      applied.push(m.id);
    });
  }
  return applied;
}

/** Splits on semicolons at end of line; migrations here contain no procedural bodies. */
function splitStatements(sql: string): string[] {
  return sql
    .split(/;\s*$/m)
    .map((s) =>
      s
        .split("\n")
        .filter((l) => !l.trim().startsWith("--"))
        .join("\n")
        .trim(),
    )
    .filter(Boolean);
}
