import argon2 from "argon2";

/**
 * Password hashing with Argon2id (OWASP recommended: m=19 MiB, t=2, p=1).
 * The parameters are stored inside the hash, so they can be raised later
 * and `needsRehash` will upgrade old hashes on the next successful login.
 */
const OPTIONS = { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 } as const;

export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 200;

export function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, OPTIONS);
}

export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, password);
  } catch {
    return false;
  }
}

export function needsRehash(hash: string): boolean {
  return argon2.needsRehash(hash, OPTIONS);
}

/** Used when the email does not exist, so login timing does not reveal registered emails. */
let dummyHash: Promise<string> | undefined;
export async function burnPasswordCheck(password: string): Promise<void> {
  dummyHash ??= hashPassword("telzyra-timing-equalizer");
  await verifyPassword(await dummyHash, password);
}
