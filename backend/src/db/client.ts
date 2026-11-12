import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client.js";
import { env } from "../config/env.js";
import { buildKeyRing, CredentialCipher } from "../security/crypto.js";

export const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: env.DATABASE_URL }),
});

export const cipher = new CredentialCipher(
  buildKeyRing(env.CREDENTIALS_KEY, env.CREDENTIALS_KEY_VERSION, env.CREDENTIALS_PREVIOUS_KEYS),
);

export type Db = typeof prisma;
