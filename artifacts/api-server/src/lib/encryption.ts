import { createCipheriv, createDecipheriv, randomBytes, hkdfSync } from "node:crypto";

// AES-256-GCM with a key derived from SESSION_SECRET via HKDF-SHA256.
// SESSION_SECRET is already required by the platform; we derive a separate
// "execution-credentials" subkey so other consumers of SESSION_SECRET (cookie
// signing, etc.) don't share the same material.

const ALGO = "aes-256-gcm" as const;
const KEY_LEN = 32;
const IV_LEN = 12;
const TAG_LEN = 16;

let cachedKey: Buffer | null = null;

function getKey(): Buffer {
  if (cachedKey) return cachedKey;
  const secret = process.env["SESSION_SECRET"];
  if (!secret || secret.length < 16) {
    throw new Error(
      "SESSION_SECRET is required (min 16 chars) for execution-credential encryption"
    );
  }
  // hkdfSync returns ArrayBuffer; wrap in Node Buffer for crypto APIs.
  const derived = hkdfSync(
    "sha256",
    Buffer.from(secret, "utf8"),
    Buffer.alloc(0),
    Buffer.from("mothership.execution.v1", "utf8"),
    KEY_LEN,
  );
  cachedKey = Buffer.from(derived);
  return cachedKey;
}

export type EncryptedBlob = {
  v: 1;
  iv: string; // hex
  tag: string; // hex
  ct: string; // hex
};

export function encryptSecret(plaintext: string): string {
  const key = getKey();
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  const blob: EncryptedBlob = {
    v: 1,
    iv: iv.toString("hex"),
    tag: tag.toString("hex"),
    ct: ct.toString("hex"),
  };
  return JSON.stringify(blob);
}

export function decryptSecret(envelope: string): string {
  const key = getKey();
  let blob: EncryptedBlob;
  try {
    blob = JSON.parse(envelope) as EncryptedBlob;
  } catch {
    throw new Error("Encrypted credential blob is malformed");
  }
  if (blob.v !== 1) throw new Error(`Unsupported encrypted blob version: ${String(blob.v)}`);
  const iv = Buffer.from(blob.iv, "hex");
  const tag = Buffer.from(blob.tag, "hex");
  const ct = Buffer.from(blob.ct, "hex");
  if (iv.length !== IV_LEN) throw new Error("Encrypted credential IV length mismatch");
  if (tag.length !== TAG_LEN) throw new Error("Encrypted credential auth tag length mismatch");
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  return pt.toString("utf8");
}
