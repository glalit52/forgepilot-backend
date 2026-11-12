/**
 * Identity & access: users, browser sessions, API keys, workspaces a user
 * belongs to, invitations and password resets. Plain SQL over relational
 * tables; nothing here depends on workspace state.
 */
import type { Organization, Role, User } from "../contract/schemas";
import type { Persona, WorkspaceMembership } from "../domain/context";
import { hashPassword, randomToken, sha256, verifyPassword, type Vault } from "../platform/crypto";
import { generateTotpSecret, otpauthUrl, verifyTotp } from "../platform/totp";
import type { Database, Queryable } from "../platform/db";
import { HttpError } from "../platform/errors";
import { newId } from "../platform/ids";

interface UserRow {
  id: string;
  email: string;
  name: string;
  title: string;
  github_login: string | null;
  password_hash?: string | null;
  is_demo?: boolean;
}

export function toUser(r: UserRow): User {
  return {
    id: r.id,
    name: r.name,
    email: r.email,
    title: r.title,
    ...(r.github_login ? { githubLogin: r.github_login } : {}),
  };
}

export interface AuthenticatedSession {
  user: User;
  tokenHash: string;
  /** The account has two-factor sign-in on and this session has not passed it yet. */
  twoFactorPending: boolean;
}

export interface ApiKeyPrincipal {
  orgId: string;
  keyId: string;
  role: Role;
  user: User;
}

const USER_COLUMNS = `id, email, name, title, github_login`;

export class IdentityService {
  private lastSeenWrites = new Map<string, number>();

  constructor(
    private db: Database,
    private opts: {
      sessionTtlDays: number;
      demoMode: boolean;
      platformAdmins?: string[];
      vault?: Vault;
    },
  ) {}

  // ---------------------------------------------------------------- users
  async getUser(id: string, q: Queryable = this.db): Promise<User | null> {
    const { rows } = await q.query<UserRow>(`SELECT ${USER_COLUMNS} FROM users WHERE id = $1`, [
      id,
    ]);
    return rows[0] ? toUser(rows[0]) : null;
  }

  async findByEmail(
    email: string,
    q: Queryable = this.db,
  ): Promise<(User & { passwordHash: string | null }) | null> {
    const { rows } = await q.query<UserRow>(
      `SELECT ${USER_COLUMNS}, password_hash FROM users WHERE email_lower = lower($1)`,
      [email],
    );
    return rows[0] ? { ...toUser(rows[0]), passwordHash: rows[0].password_hash ?? null } : null;
  }

  async createUser(
    input: {
      name: string;
      email: string;
      password?: string;
      githubLogin?: string;
      emailVerified?: boolean;
    },
    q: Queryable = this.db,
  ): Promise<User> {
    const id = newId("u");
    const hash = input.password ? await hashPassword(input.password) : null;
    try {
      const { rows } = await q.query<UserRow>(
        `INSERT INTO users (id, email, name, github_login, password_hash, email_verified_at, is_demo)
         VALUES ($1, $2, $3, $4, $5, CASE WHEN $6 THEN now() END, $7)
         RETURNING ${USER_COLUMNS}`,
        [
          id,
          input.email.trim(),
          input.name.trim(),
          input.githubLogin ?? null,
          hash,
          !!input.emailVerified,
          this.opts.demoMode,
        ],
      );
      return toUser(rows[0]);
    } catch (err) {
      if (isUniqueViolation(err))
        throw new HttpError(409, "An account with that email already exists. Sign in instead.");
      throw err;
    }
  }

  async updateProfile(userId: string, patch: { name?: string; title?: string }): Promise<User> {
    const { rows } = await this.db.tx(async (q) => {
      const r = await q.query<UserRow>(
        `UPDATE users SET name = COALESCE($2, name), title = COALESCE($3, title), updated_at = now()
         WHERE id = $1 RETURNING ${USER_COLUMNS}`,
        [userId, patch.name ?? null, patch.title ?? null],
      );
      // Workspace snapshots embed member names; bump their revision so caches refresh.
      await q.query(
        `UPDATE organizations SET rev = rev + 1 WHERE id IN (SELECT org_id FROM memberships WHERE user_id = $1)`,
        [userId],
      );
      return r;
    });
    if (!rows[0]) throw new HttpError(404, "User not found");
    return toUser(rows[0]);
  }

  async checkPassword(email: string, password: string): Promise<User | null> {
    const user = await this.findByEmail(email);
    const ok = await verifyPassword(password, user?.passwordHash ?? null);
    if (!user || !ok) return null;
    const { passwordHash: _hash, ...rest } = user;
    return rest;
  }

  async setPassword(userId: string, password: string, q: Queryable = this.db) {
    await q.query(`UPDATE users SET password_hash = $2, updated_at = now() WHERE id = $1`, [
      userId,
      await hashPassword(password),
    ]);
  }

  /** Finds or creates the user behind an OAuth identity; links by verified email when one exists. */
  async upsertOAuthUser(input: {
    provider: string;
    providerUserId: string;
    email: string;
    name: string;
    login?: string;
  }): Promise<User> {
    return this.db.tx(async (q) => {
      const linked = await q.query<UserRow>(
        `SELECT ${USER_COLUMNS.split(", ")
          .map((c) => `u.${c}`)
          .join(", ")}
         FROM identities i JOIN users u ON u.id = i.user_id
         WHERE i.provider = $1 AND i.provider_user_id = $2`,
        [input.provider, input.providerUserId],
      );
      if (linked.rows[0]) return toUser(linked.rows[0]);
      const existing = await this.findByEmail(input.email, q);
      if (existing) {
        // The address may have been registered by someone who never proved they own it.
        // GitHub has verified it for this person, so the account becomes theirs: any
        // password set before and every open session are dropped.
        const { rows } = await q.query<{ verified: boolean }>(
          `SELECT email_verified_at IS NOT NULL AS verified FROM users WHERE id = $1`,
          [existing.id],
        );
        if (!rows[0]?.verified) {
          await q.query(
            `UPDATE users SET password_hash = NULL, email_verified_at = now() WHERE id = $1`,
            [existing.id],
          );
          await this.destroyAllSessions(existing.id, q);
        }
      }
      const user =
        existing ??
        (await this.createUser(
          { name: input.name, email: input.email, githubLogin: input.login, emailVerified: true },
          q,
        ));
      if (existing && input.login)
        await q.query(`UPDATE users SET github_login = COALESCE(github_login, $2) WHERE id = $1`, [
          existing.id,
          input.login,
        ]);
      await q.query(
        `INSERT INTO identities (provider, provider_user_id, user_id) VALUES ($1, $2, $3)`,
        [input.provider, input.providerUserId, user.id],
      );
      return {
        id: user.id,
        name: user.name,
        email: user.email,
        title: user.title,
        githubLogin: user.githubLogin ?? input.login,
      };
    });
  }

  // ---------------------------------------------------------------- email verification & staff
  async issueEmailVerification(userId: string, q: Queryable = this.db): Promise<string> {
    const token = randomToken(32);
    await q.query(
      `INSERT INTO email_verifications (token_hash, user_id, expires_at) VALUES ($1, $2, now() + interval '3 days')`,
      [sha256(token), userId],
    );
    return token;
  }

  async verifyEmail(token: string): Promise<boolean> {
    return this.db.tx(async (q) => {
      const { rows } = await q.query<{ user_id: string }>(
        `DELETE FROM email_verifications WHERE token_hash = $1 AND expires_at > now() RETURNING user_id`,
        [sha256(token)],
      );
      if (!rows[0]) return false;
      await q.query(
        `UPDATE users SET email_verified_at = COALESCE(email_verified_at, now()) WHERE id = $1`,
        [rows[0].user_id],
      );
      return true;
    });
  }

  /**
   * ForgePilot staff: the email is on the configured list AND has been verified.
   * Without the second condition anyone could sign up with a staff address.
   */
  async isStaff(userId: string): Promise<boolean> {
    const admins = this.opts.platformAdmins ?? [];
    if (!admins.length) return false;
    // Staff reach every customer, so a password alone is never enough: two-factor must be on.
    // (A session that hasn't passed it is rejected before this check is reached.)
    const { rows } = await this.db.query<{ email_lower: string }>(
      `SELECT email_lower FROM users
       WHERE id = $1 AND email_verified_at IS NOT NULL AND totp_enabled_at IS NOT NULL AND NOT is_demo`,
      [userId],
    );
    return !!rows[0] && admins.includes(rows[0].email_lower);
  }

  // ---------------------------------------------------------------- browser sessions
  /** Returns the opaque token for the cookie; only its SHA-256 is stored. */
  async createSession(
    userId: string,
    meta: { ip: string | null; userAgent: string | null },
  ): Promise<string> {
    const token = randomToken(32);
    await this.db.query(
      `INSERT INTO auth_sessions (token_hash, user_id, expires_at, ip, user_agent)
       VALUES ($1, $2, now() + ($3::int * interval '1 day'), $4, $5)`,
      [
        sha256(token),
        userId,
        this.opts.sessionTtlDays,
        meta.ip,
        meta.userAgent?.slice(0, 400) ?? null,
      ],
    );
    return token;
  }

  async resolveSession(token: string | undefined): Promise<AuthenticatedSession | null> {
    if (!token || token.length < 20 || token.length > 200) return null;
    const tokenHash = sha256(token);
    const { rows } = await this.db.query<UserRow & { pending: boolean }>(
      `SELECT u.id, u.email, u.name, u.title, u.github_login,
              (u.totp_enabled_at IS NOT NULL AND s.two_factor_at IS NULL) AS pending
       FROM auth_sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = $1 AND s.expires_at > now()`,
      [tokenHash],
    );
    if (!rows[0]) return null;
    // Sliding activity marker, written at most once a minute per session.
    const now = Date.now();
    if (now - (this.lastSeenWrites.get(tokenHash) ?? 0) > 60_000) {
      this.lastSeenWrites.set(tokenHash, now);
      if (this.lastSeenWrites.size > 10_000) this.lastSeenWrites.clear();
      void this.db
        .query(`UPDATE auth_sessions SET last_seen_at = now() WHERE token_hash = $1`, [tokenHash])
        .catch(() => undefined);
    }
    return { user: toUser(rows[0]), tokenHash, twoFactorPending: rows[0].pending };
  }

  // ---------------------------------------------------------------- two-factor sign-in
  private get vault(): Vault {
    if (!this.opts.vault) throw new Error("Two-factor sign-in needs the credential vault");
    return this.opts.vault;
  }

  async twoFactorStatus(userId: string): Promise<{ enabled: boolean; staffEligible: boolean }> {
    const { rows } = await this.db.query<{
      enabled: boolean;
      email_lower: string;
      verified: boolean;
      is_demo: boolean;
    }>(
      `SELECT totp_enabled_at IS NOT NULL AS enabled, email_lower, email_verified_at IS NOT NULL AS verified, is_demo
       FROM users WHERE id = $1`,
      [userId],
    );
    const r = rows[0];
    return {
      enabled: !!r?.enabled,
      staffEligible:
        !!r && r.verified && !r.is_demo && (this.opts.platformAdmins ?? []).includes(r.email_lower),
    };
  }

  /** Starts enrolment: stores a new secret (encrypted) that only becomes active once a code confirms it. */
  async beginTwoFactor(user: User): Promise<{ secret: string; otpauthUrl: string }> {
    const { enabled } = await this.twoFactorStatus(user.id);
    if (enabled) throw new HttpError(409, "Two-factor sign-in is already on for this account");
    const secret = generateTotpSecret();
    await this.db.query(`UPDATE users SET totp_secret_ct = $2 WHERE id = $1`, [
      user.id,
      this.vault.encrypt(secret, `totp:${user.id}`),
    ]);
    return { secret, otpauthUrl: otpauthUrl(secret, user.email, "ForgePilot") };
  }

  /**
   * Checks a code for the user. Each code works once: the step it belongs to is
   * remembered, so a code that was observed can't be replayed.
   */
  private async checkTwoFactorCode(q: Queryable, userId: string, code: string): Promise<boolean> {
    const { rows } = await q.query<{
      totp_secret_ct: string | null;
      totp_last_counter: number | null;
    }>(`SELECT totp_secret_ct, totp_last_counter FROM users WHERE id = $1 FOR UPDATE`, [userId]);
    const r = rows[0];
    if (!r?.totp_secret_ct) return false;
    const counter = verifyTotp(this.vault.decrypt(r.totp_secret_ct, `totp:${userId}`), code);
    if (counter === null || counter <= Number(r.totp_last_counter ?? -1)) return false;
    await q.query(`UPDATE users SET totp_last_counter = $2 WHERE id = $1`, [userId, counter]);
    return true;
  }

  /** Confirms enrolment with a first code and marks the current session as verified. */
  async enableTwoFactor(userId: string, tokenHash: string, code: string): Promise<boolean> {
    return this.db.tx(async (q) => {
      if (!(await this.checkTwoFactorCode(q, userId, code))) return false;
      await q.query(
        `UPDATE users SET totp_enabled_at = COALESCE(totp_enabled_at, now()) WHERE id = $1`,
        [userId],
      );
      await q.query(`UPDATE auth_sessions SET two_factor_at = now() WHERE token_hash = $1`, [
        tokenHash,
      ]);
      // Other sessions were opened without the second factor: end them.
      await q.query(`DELETE FROM auth_sessions WHERE user_id = $1 AND token_hash <> $2`, [
        userId,
        tokenHash,
      ]);
      return true;
    });
  }

  async passTwoFactor(userId: string, tokenHash: string, code: string): Promise<boolean> {
    return this.db.tx(async (q) => {
      if (!(await this.checkTwoFactorCode(q, userId, code))) return false;
      await q.query(`UPDATE auth_sessions SET two_factor_at = now() WHERE token_hash = $1`, [
        tokenHash,
      ]);
      return true;
    });
  }

  async disableTwoFactor(userId: string, code: string): Promise<boolean> {
    return this.db.tx(async (q) => {
      if (!(await this.checkTwoFactorCode(q, userId, code))) return false;
      await q.query(
        `UPDATE users SET totp_enabled_at = NULL, totp_secret_ct = NULL, totp_last_counter = NULL WHERE id = $1`,
        [userId],
      );
      return true;
    });
  }

  async destroySession(token: string | undefined) {
    if (token)
      await this.db.query(`DELETE FROM auth_sessions WHERE token_hash = $1`, [sha256(token)]);
  }

  async destroyAllSessions(userId: string, q: Queryable = this.db) {
    await q.query(`DELETE FROM auth_sessions WHERE user_id = $1`, [userId]);
  }

  // ---------------------------------------------------------------- memberships
  async membershipsOf(userId: string): Promise<WorkspaceMembership[]> {
    const { rows } = await this.db.query<{ data: Organization; role: Role }>(
      `SELECT o.data, m.role FROM memberships m JOIN organizations o ON o.id = m.org_id
       WHERE m.user_id = $1 AND m.removed_at IS NULL ORDER BY m.joined_at, o.id`,
      [userId],
    );
    return rows.map((r) => ({ organization: r.data, role: r.role }));
  }

  /** Demo personas for the sign-in screen. Empty outside demo mode. */
  async personas(): Promise<Persona[]> {
    if (!this.opts.demoMode) return [];
    const { rows } = await this.db.query<
      UserRow & { org_id: string; org_name: string; role: Role }
    >(
      `SELECT u.id, u.email, u.name, u.title, u.github_login, o.id AS org_id, o.data->>'name' AS org_name, m.role
       FROM users u JOIN memberships m ON m.user_id = u.id AND m.removed_at IS NULL
       JOIN organizations o ON o.id = m.org_id
       WHERE u.is_demo ORDER BY u.created_at, u.id, m.joined_at, o.id`,
    );
    const byId = new Map<string, Persona>();
    for (const r of rows) {
      if (!byId.has(r.id)) byId.set(r.id, { ...toUser(r), workspaces: [] });
      byId.get(r.id)!.workspaces.push({ orgId: r.org_id, name: r.org_name, role: r.role });
    }
    return [...byId.values()];
  }

  // ---------------------------------------------------------------- API keys
  async registerApiKey(
    q: Queryable,
    input: { orgId: string; keyId: string; secret: string; createdBy: string; role: Role },
  ) {
    await q.query(
      `INSERT INTO api_key_secrets (token_hash, org_id, key_id, created_by, role) VALUES ($1, $2, $3, $4, $5)`,
      [sha256(input.secret), input.orgId, input.keyId, input.createdBy, input.role],
    );
  }

  async revokeApiKey(q: Queryable, orgId: string, keyId: string) {
    await q.query(`DELETE FROM api_key_secrets WHERE org_id = $1 AND key_id = $2`, [orgId, keyId]);
  }

  /**
   * A key acts as the member who created it, capped at the role it was created with.
   * If that person left the workspace or was demoted, the key loses access with them.
   */
  async resolveApiKey(secret: string): Promise<ApiKeyPrincipal | null> {
    if (!/^fp_live_[A-Za-z0-9]{20,64}$/.test(secret)) return null;
    const { rows } = await this.db.query<
      UserRow & { org_id: string; key_id: string; key_role: Role; member_role: Role | null }
    >(
      `SELECT k.org_id, k.key_id, k.role AS key_role, m.role AS member_role, u.id, u.email, u.name, u.title, u.github_login
       FROM api_key_secrets k JOIN users u ON u.id = k.created_by
       LEFT JOIN memberships m ON m.org_id = k.org_id AND m.user_id = k.created_by AND m.removed_at IS NULL
       WHERE k.token_hash = $1`,
      [sha256(secret)],
    );
    const r = rows[0];
    if (!r || !r.member_role) return null;
    const rank: Record<Role, number> = { viewer: 0, member: 1, admin: 2, owner: 3 };
    const role = rank[r.key_role] <= rank[r.member_role] ? r.key_role : r.member_role;
    return { orgId: r.org_id, keyId: r.key_id, role, user: toUser(r) };
  }

  // ---------------------------------------------------------------- invitations
  async issueInvitation(
    q: Queryable,
    input: { orgId: string; invitationId: string; email: string },
  ): Promise<string> {
    const token = randomToken(32);
    await q.query(
      `INSERT INTO invitation_tokens (token_hash, org_id, invitation_id, email, expires_at)
       VALUES ($1, $2, $3, $4, now() + interval '14 days')`,
      [sha256(token), input.orgId, input.invitationId, input.email],
    );
    return token;
  }

  async revokeInvitation(q: Queryable, orgId: string, invitationId: string) {
    await q.query(`DELETE FROM invitation_tokens WHERE org_id = $1 AND invitation_id = $2`, [
      orgId,
      invitationId,
    ]);
  }

  async findInvitation(
    token: string,
  ): Promise<{ orgId: string; invitationId: string; email: string } | null> {
    const { rows } = await this.db.query<{ org_id: string; invitation_id: string; email: string }>(
      `SELECT org_id, invitation_id, email FROM invitation_tokens WHERE token_hash = $1 AND expires_at > now()`,
      [sha256(token)],
    );
    return rows[0]
      ? { orgId: rows[0].org_id, invitationId: rows[0].invitation_id, email: rows[0].email }
      : null;
  }

  // ---------------------------------------------------------------- password reset
  async issuePasswordReset(userId: string): Promise<string> {
    const token = randomToken(32);
    await this.db.query(
      `INSERT INTO password_resets (token_hash, user_id, expires_at) VALUES ($1, $2, now() + interval '1 hour')`,
      [sha256(token), userId],
    );
    return token;
  }

  /** Single use. Every existing session is revoked so a stolen session dies with the old password. */
  async consumePasswordReset(token: string, password: string): Promise<boolean> {
    return this.db.tx(async (q) => {
      const { rows } = await q.query<{ user_id: string }>(
        `UPDATE password_resets SET used_at = now()
         WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now() RETURNING user_id`,
        [sha256(token)],
      );
      if (!rows[0]) return false;
      await this.setPassword(rows[0].user_id, password, q);
      await this.destroyAllSessions(rows[0].user_id, q);
      return true;
    });
  }

  async purgeExpired() {
    await this.db.query(`DELETE FROM auth_sessions WHERE expires_at < now()`);
    await this.db.query(`DELETE FROM password_resets WHERE expires_at < now() - interval '1 day'`);
    await this.db.query(`DELETE FROM invitation_tokens WHERE expires_at < now()`);
    await this.db.query(`DELETE FROM email_verifications WHERE expires_at < now()`);
  }
}

export function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === "23505";
}
