/**
 * Cryptographic helpers: token hashing, password hashing (scrypt), HMAC
 * signatures and the credential vault (AES-256-GCM, envelope per record).
 */
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  scrypt as scryptCb,
  timingSafeEqual,
} from "node:crypto";

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Opaque bearer secret, e.g. a session token. 256 bits of entropy. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function hmacSha256(secret: string, payload: string | Buffer): string {
  return createHmac("sha256", secret).update(payload).digest("hex");
}

// ---------------------------------------------------------------- passwords
const SCRYPT = { N: 1 << 15, r: 8, p: 1, keylen: 64, maxmem: 128 * 1024 * 1024 };

function scrypt(password: string, salt: Buffer, n: number): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scryptCb(
      password.normalize("NFKC"),
      salt,
      SCRYPT.keylen,
      { N: n, r: SCRYPT.r, p: SCRYPT.p, maxmem: SCRYPT.maxmem },
      (err, key) => (err ? reject(err) : resolve(key)),
    ),
  );
}

/** Format: scrypt$N$salt$hash (base64url). The cost travels with the hash so it can be raised later. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, SCRYPT.N);
  return `scrypt$${SCRYPT.N}$${salt.toString("base64url")}$${key.toString("base64url")}`;
}

export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  if (!stored) {
    // Spend the same time as a real check so missing accounts can't be detected by timing.
    await scrypt(password, Buffer.alloc(16), SCRYPT.N);
    return false;
  }
  const [scheme, n, salt, hash] = stored.split("$");
  if (scheme !== "scrypt" || !n || !salt || !hash) return false;
  const key = await scrypt(password, Buffer.from(salt, "base64url"), Number(n));
  const expected = Buffer.from(hash, "base64url");
  return key.length === expected.length && timingSafeEqual(key, expected);
}

// ---------------------------------------------------------------- vault
/**
 * Encrypts integration credentials at rest. The database only ever holds
 * ciphertext; the key lives in the environment (or a KMS-backed secret).
 * Record format: v1.<iv>.<tag>.<ciphertext>, with the owning workspace and
 * provider bound as additional authenticated data so a row can't be replayed
 * into another tenant.
 */
export class Vault {
  private key: Buffer;

  constructor(key: string | undefined, opts: { allowEphemeral: boolean }) {
    if (key) {
      const raw = /^[0-9a-f]{64}$/i.test(key)
        ? Buffer.from(key, "hex")
        : Buffer.from(key, "base64");
      if (raw.length !== 32) throw new Error("VAULT_KEY must decode to exactly 32 bytes");
      this.key = raw;
    } else if (opts.allowEphemeral) {
      this.key = randomBytes(32);
    } else {
      throw new Error("VAULT_KEY is required");
    }
  }

  encrypt(plaintext: string, aad: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(Buffer.from(aad));
    const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    return ["v1", iv, cipher.getAuthTag(), body]
      .map((p) => (typeof p === "string" ? p : p.toString("base64url")))
      .join(".");
  }

  decrypt(record: string, aad: string): string {
    const [version, iv, tag, body] = record.split(".");
    if (version !== "v1" || !iv || !tag || body === undefined)
      throw new Error("Unknown vault record format");
    const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(iv, "base64url"));
    decipher.setAAD(Buffer.from(aad));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(body, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  }
}

// ---------------------------------------------------------------- redaction
const SECRET_PATTERNS = [
  /sk-[A-Za-z0-9_-]{6,}/g,
  /gh[pousr]_[A-Za-z0-9]{6,}/g,
  /github_pat_[A-Za-z0-9_]{6,}/g,
  /AKIA[0-9A-Z]{8,}/g,
  /xox[abprs]-[A-Za-z0-9-]{6,}/g,
  /fp_live_[A-Za-z0-9]{6,}/g,
  /x-access-token:[^@\s]+/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];

/** Removes anything that looks like a credential before text is stored or shown (PRD DP-005). */
export function redactSecrets(text: string, extra: string[] = []): { text: string; count: number } {
  let count = 0;
  let out = text;
  for (const secret of extra) {
    if (secret.length < 6) continue;
    const parts = out.split(secret);
    count += parts.length - 1;
    out = parts.join("[REDACTED]");
  }
  for (const pattern of SECRET_PATTERNS)
    out = out.replace(pattern, () => {
      count++;
      return "[REDACTED]";
    });
  return { text: out, count };
}
