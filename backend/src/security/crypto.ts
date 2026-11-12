import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Credential encryption: AES-256-GCM.
 *
 * Packed format (single DB column):  tz1.<keyVersion>.<iv>.<authTag>.<ciphertext>   (base64url parts)
 *  - 96-bit random IV per encryption (never reused with the same key)
 *  - 128-bit auth tag: any modification of the ciphertext fails decryption
 *  - AAD binds the ciphertext to its owner (e.g. "credential:<workspaceId>:<connectionId>"),
 *    so a value copied to another row or tenant cannot be decrypted there.
 *  - keyVersion allows key rotation: new data uses the current key, old data stays readable.
 */
const PREFIX = "tz1";
const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;
const TAG_BYTES = 16;

export interface KeyRing {
  current: { version: number; key: Buffer };
  previous: Map<number, Buffer>;
}

export class DecryptionError extends Error {
  constructor(reason: string) {
    super(`Decryption failed: ${reason}`);
    this.name = "DecryptionError";
  }
}

export function buildKeyRing(currentHex: string, currentVersion: number, previous?: string): KeyRing {
  const key = Buffer.from(currentHex, "hex");
  if (key.length !== 32) throw new Error("CREDENTIALS_KEY must be 32 bytes (64 hex chars)");
  const prev = new Map<number, Buffer>();
  for (const entry of (previous ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
    const [v, hex] = entry.split(":");
    const k = Buffer.from(hex ?? "", "hex");
    if (!v || k.length !== 32) throw new Error("CREDENTIALS_PREVIOUS_KEYS must look like '1:<64 hex>'");
    prev.set(Number(v), k);
  }
  return { current: { version: currentVersion, key }, previous: prev };
}

const b64 = (b: Buffer) => b.toString("base64url");

export class CredentialCipher {
  constructor(private readonly keys: KeyRing) {}

  get currentVersion() {
    return this.keys.current.version;
  }

  encrypt(plaintext: string, aad: string): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, this.keys.current.key, iv, { authTagLength: TAG_BYTES });
    cipher.setAAD(Buffer.from(aad, "utf8"));
    const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [PREFIX, this.keys.current.version, b64(iv), b64(tag), b64(ct)].join(".");
  }

  decrypt(packed: string, aad: string): string {
    const parts = packed.split(".");
    if (parts.length !== 5 || parts[0] !== PREFIX) throw new DecryptionError("unknown format");
    const version = Number(parts[1]);
    const key = version === this.keys.current.version ? this.keys.current.key : this.keys.previous.get(version);
    if (!key) throw new DecryptionError(`no key for version ${version}`);
    const iv = Buffer.from(parts[2]!, "base64url");
    const tag = Buffer.from(parts[3]!, "base64url");
    const ct = Buffer.from(parts[4]!, "base64url");
    if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) throw new DecryptionError("malformed");
    try {
      const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
      decipher.setAAD(Buffer.from(aad, "utf8"));
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
    } catch {
      throw new DecryptionError("authentication failed");
    }
  }

  encryptJson(value: unknown, aad: string): string {
    return this.encrypt(JSON.stringify(value), aad);
  }

  decryptJson<T>(packed: string, aad: string): T {
    return JSON.parse(this.decrypt(packed, aad)) as T;
  }

  /** True when the value was written with an older key and should be re-encrypted. */
  needsRotation(packed: string): boolean {
    return Number(packed.split(".")[1]) !== this.keys.current.version;
  }
}

/** Random URL-safe token (session tokens, OAuth state, webhook endpoint tokens). */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

/** One-way hash for storing lookup tokens (sessions, OAuth state). */
export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function hmacSha256(key: string | Buffer, value: string): string {
  return createHmac("sha256", key).update(value).digest("base64url");
}

/** Constant-time string comparison. */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
