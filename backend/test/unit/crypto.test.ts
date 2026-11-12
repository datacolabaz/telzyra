import { describe, expect, it } from "vitest";
import { buildKeyRing, CredentialCipher, DecryptionError, randomToken, safeEqual, sha256 } from "../../src/security/crypto.js";

const K1 = "1".repeat(64);
const K2 = "2".repeat(64);
const AAD = "credential:ws-1:conn-1";

describe("CredentialCipher (AES-256-GCM)", () => {
  const cipher = new CredentialCipher(buildKeyRing(K2, 2, `1:${K1}`));

  it("round-trips plaintext and JSON", () => {
    const packed = cipher.encrypt("hello", AAD);
    expect(cipher.decrypt(packed, AAD)).toBe("hello");
    const json = { accessToken: "at", refreshToken: "rt", expiresIn: 3600 };
    expect(cipher.decryptJson(cipher.encryptJson(json, AAD), AAD)).toEqual(json);
  });

  it("never stores plaintext and uses a fresh IV every time", () => {
    const a = cipher.encrypt("same-secret", AAD);
    const b = cipher.encrypt("same-secret", AAD);
    expect(a).not.toBe(b);
    expect(a).not.toContain("same-secret");
    expect(a.startsWith("tz1.2.")).toBe(true);
  });

  it("rejects ciphertext moved to another tenant or row (AAD mismatch)", () => {
    const packed = cipher.encrypt("secret", AAD);
    expect(() => cipher.decrypt(packed, "credential:ws-2:conn-1")).toThrow(DecryptionError);
  });

  it("rejects tampered ciphertext, tag or IV", () => {
    const parts = cipher.encrypt("secret", AAD).split(".");
    for (const i of [2, 3, 4]) {
      const bad = [...parts];
      const buf = Buffer.from(bad[i]!, "base64url");
      buf[0] = buf[0]! ^ 0xff;
      bad[i] = buf.toString("base64url");
      expect(() => cipher.decrypt(bad.join("."), AAD)).toThrow(DecryptionError);
    }
  });

  it("decrypts data written with a previous key and flags it for rotation", () => {
    const old = new CredentialCipher(buildKeyRing(K1, 1));
    const packed = old.encrypt("legacy", AAD);
    expect(cipher.decrypt(packed, AAD)).toBe("legacy");
    expect(cipher.needsRotation(packed)).toBe(true);
    expect(cipher.needsRotation(cipher.encrypt("new", AAD))).toBe(false);
  });

  it("fails clearly for unknown key versions and formats", () => {
    const other = new CredentialCipher(buildKeyRing(K1, 9));
    expect(() => cipher.decrypt(other.encrypt("x", AAD), AAD)).toThrow(/no key for version 9/);
    expect(() => cipher.decrypt("not-a-secret", AAD)).toThrow(/unknown format/);
  });

  it("validates key material", () => {
    expect(() => buildKeyRing("abc", 1)).toThrow();
    expect(() => buildKeyRing(K1, 1, "1:short")).toThrow();
  });
});

describe("token helpers", () => {
  it("creates unique url-safe tokens", () => {
    const t = randomToken(32);
    expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(randomToken()).not.toBe(t);
  });
  it("hashes deterministically and compares in constant time", () => {
    expect(sha256("a")).toBe(sha256("a"));
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual("abc", "abcd")).toBe(false);
  });
});
