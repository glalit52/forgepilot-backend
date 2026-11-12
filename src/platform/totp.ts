/**
 * Time-based one-time passwords (RFC 6238): the 6-digit codes authenticator
 * apps show. SHA-1, 30-second steps, which is what every authenticator supports.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const STEP_SECONDS = 30;

export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

export function base32Encode(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Buffer {
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of text.toUpperCase().replace(/[^A-Z2-7]/g, "")) {
    value = (value << 5) | ALPHABET.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function totpCounter(now = Date.now()): number {
  return Math.floor(now / 1000 / STEP_SECONDS);
}

export function totpCode(secret: string, counter: number): string {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac("sha1", base32Decode(secret)).update(message).digest();
  const offset = digest[digest.length - 1] & 15;
  const binary = digest.readUInt32BE(offset) & 0x7fffffff;
  return String(binary % 1_000_000).padStart(6, "0");
}

/**
 * Checks a code against the current step and one step either side (clock drift).
 * Returns the matching counter so the caller can refuse to accept the same code twice.
 */
export function verifyTotp(secret: string, code: string, now = Date.now()): number | null {
  const given = Buffer.from(code.replace(/\s/g, ""));
  if (given.length !== 6) return null;
  const current = totpCounter(now);
  for (const counter of [current, current - 1, current + 1]) {
    const expected = Buffer.from(totpCode(secret, counter));
    if (timingSafeEqual(given, expected)) return counter;
  }
  return null;
}

/** The link authenticator apps read from a QR code or accept pasted. */
export function otpauthUrl(secret: string, account: string, issuer: string): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}
