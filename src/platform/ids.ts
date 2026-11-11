import { createHash, randomBytes } from "node:crypto";

const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";

/** Random, URL-safe, lowercase id body (≈62 bits for the default 12 chars). */
export function randomId(length = 12): string {
  const bytes = randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}

/** Prefixed entity id, e.g. `task_k3j9x0a1b2c4`. Prefixes make ids self-describing in logs. */
export function newId(prefix: string): string {
  return `${prefix}_${randomId()}`;
}

/** ISO timestamp without milliseconds: the wire format of the API contract. */
export function toIso(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** Deterministic 40-hex digest. Only used where no real commit exists yet (simulated execution). */
export function pseudoSha(seed: string): string {
  return createHash("sha1").update(seed).digest("hex");
}
