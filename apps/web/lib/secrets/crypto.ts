// App-layer AES-256-GCM for secrets at rest (replaces the pgcrypto-in-DB +
// Supabase-Vault key scheme). The master key lives in the environment
// (SECRETS_ENCRYPTION_KEY) — not in the database — so there's no superuser-GUC
// dependency and the key is portable. Cloned from the proven SlideLang
// lib/crypto.ts.
//
// The DB stores only OPAQUE bytes: `*_encrypted` = [aes-gcm ciphertext ‖ authTag
// (16 bytes)], `*_iv` = the 12-byte GCM nonce. The app encrypts before writing
// and decrypts after reading — a raw row dump is useless without the env key.
//
// Master key: 32-byte (256-bit) base64. Generate one with:
//   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
// Losing it makes every stored secret unrecoverable — keep it safe + backed up.

import "server-only";

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGO = "aes-256-gcm";
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

let cachedKey: Buffer | null = null;

function loadMasterKey(): Buffer {
  if (cachedKey) return cachedKey;
  const raw = process.env.SECRETS_ENCRYPTION_KEY;
  if (!raw) {
    throw new Error(
      "SECRETS_ENCRYPTION_KEY is not set. Generate one with " +
        `\`node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"\` and add it to .env.local`,
    );
  }
  const decoded = Buffer.from(raw, "base64");
  if (decoded.length !== KEY_BYTES) {
    throw new Error(
      `SECRETS_ENCRYPTION_KEY must decode to ${KEY_BYTES} bytes (got ${decoded.length}).`,
    );
  }
  cachedKey = decoded;
  return decoded;
}

/** True when a usable master key is configured (lets callers fall back to env
 *  instead of throwing when encryption isn't set up — same posture as today's
 *  "no key → plaintext" transition, but now "no key → can't read encrypted"). */
export function encryptionConfigured(): boolean {
  try {
    loadMasterKey();
    return true;
  } catch {
    return false;
  }
}

export type EncryptResult = { ciphertext: Buffer; iv: Buffer; last4: string };

export function encryptSecret(plaintext: string): EncryptResult {
  if (typeof plaintext !== "string" || plaintext.length === 0) {
    throw new Error("encryptSecret: plaintext must be a non-empty string");
  }
  const key = loadMasterKey();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { ciphertext: Buffer.concat([enc, tag]), iv, last4: plaintext.slice(-4) };
}

export function decryptSecret(ciphertext: Buffer, iv: Buffer): string {
  if (!Buffer.isBuffer(ciphertext) || ciphertext.length < TAG_BYTES + 1) {
    throw new Error("decryptSecret: ciphertext is empty or malformed");
  }
  if (!Buffer.isBuffer(iv) || iv.length !== IV_BYTES) {
    throw new Error(`decryptSecret: iv must be ${IV_BYTES} bytes`);
  }
  const key = loadMasterKey();
  const tag = ciphertext.subarray(ciphertext.length - TAG_BYTES);
  const enc = ciphertext.subarray(0, ciphertext.length - TAG_BYTES);
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8");
}

export function last4(plaintext: string): string {
  return plaintext.slice(-4);
}

// ── bytea wire format ───────────────────────────────────────────────────────
// PostgREST/supabase-js does NOT auto-convert Buffer to bytea — it JSON-encodes
// it as {"type":"Buffer",...} and stores that garbage. The portable way to send
// bytea is a hex string prefixed with `\x`. On read, bytea comes back as `\x…`
// hex (Postgres default) or base64 depending on driver — handle both.

export function toBytea(buf: Buffer): string {
  return "\\x" + buf.toString("hex");
}

export function fromBytea(v: unknown): Buffer | null {
  if (Buffer.isBuffer(v)) return v;
  if (typeof v === "string") {
    if (v.startsWith("\\x")) return Buffer.from(v.slice(2), "hex");
    return Buffer.from(v, "base64");
  }
  if (v && typeof v === "object" && (v as { type?: string }).type === "Buffer") {
    const data = (v as { data?: number[] }).data;
    if (Array.isArray(data)) return Buffer.from(data);
  }
  return null;
}

/** Convenience: decrypt a (ciphertext, iv) pair as they come back from
 *  supabase-js (bytea columns). Returns null if either is missing/malformed. */
export function decryptColumns(encryptedCol: unknown, ivCol: unknown): string | null {
  const enc = fromBytea(encryptedCol);
  const iv = fromBytea(ivCol);
  if (!enc || !iv) return null;
  return decryptSecret(enc, iv);
}
