import { z } from "zod";
import type { Db } from "../db/client.js";
import { Errors } from "../lib/errors.js";
import { randomToken } from "../security/crypto.js";
import { Prisma } from "../generated/prisma/client.js";
import { burnPasswordCheck, hashPassword, needsRehash, PASSWORD_MAX, PASSWORD_MIN, verifyPassword } from "./password.js";

const LOCALES = ["en", "az", "ru", "tr"] as const;

/** Default workspace name in the user's language. */
const WORKSPACE_NAME: Record<(typeof LOCALES)[number], (first: string) => string> = {
  en: (f) => `${f}'s workspace`,
  az: (f) => `${f} — iş sahəsi`,
  ru: (f) => `Пространство ${f}`,
  tr: (f) => `${f} çalışma alanı`,
};

/** Validation errors use the same codes as the frontend's validation.json. */
export const registerSchema = z.object({
  name: z.string().trim().min(1, "required").min(2, "nameMin").max(120),
  email: z.string().trim().toLowerCase().min(1, "required").max(254).email("email"),
  password: z.string().min(1, "required").min(PASSWORD_MIN, "passwordMin").max(PASSWORD_MAX),
  locale: z.enum(LOCALES).default("en"),
  workspaceName: z.string().trim().min(2).max(120).optional(),
});

export const loginSchema = z.object({
  email: z.string().trim().toLowerCase().min(1, "required").max(254).email("email"),
  password: z.string().min(1, "required").max(PASSWORD_MAX),
});

const PARAMS: Record<string, Record<string, number>> = {
  passwordMin: { min: PASSWORD_MIN },
  nameMin: { min: 2 },
};

export function parseOrThrow<T extends z.ZodType>(schema: T, input: unknown): z.infer<T> {
  const result = schema.safeParse(input ?? {});
  if (result.success) return result.data;
  const fields: Record<string, { code: string; params?: Record<string, number> }> = {};
  for (const issue of result.error.issues) {
    const field = String(issue.path[0] ?? "form");
    if (fields[field]) continue;
    const code = issue.message in PARAMS || ["required", "email"].includes(issue.message) ? issue.message : "invalid";
    fields[field] = { code, ...(PARAMS[code] ? { params: PARAMS[code] } : {}) };
  }
  throw Errors.validation(fields);
}

function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return `${base || "workspace"}-${randomToken(4).toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 5)}`;
}

export type PublicUser = { id: string; email: string; name: string; locale: string; emailVerified: boolean };

export function toPublicUser(u: { id: string; email: string; name: string; locale: string; emailVerifiedAt: Date | null }): PublicUser {
  return { id: u.id, email: u.email, name: u.name, locale: u.locale, emailVerified: !!u.emailVerifiedAt };
}

export class AuthService {
  constructor(private readonly db: Db) {}

  /** Creates the user, their first workspace and an OWNER membership in one transaction. */
  async register(input: z.infer<typeof registerSchema>) {
    const passwordHash = await hashPassword(input.password);
    try {
      return await this.db.$transaction(async (tx) => {
        const user = await tx.user.create({
          data: { email: input.email, name: input.name, passwordHash, locale: input.locale },
        });
        const workspaceName = input.workspaceName ?? WORKSPACE_NAME[input.locale](input.name.split(" ")[0]!);
        const workspace = await tx.workspace.create({ data: { name: workspaceName, slug: slugify(workspaceName) } });
        await tx.membership.create({ data: { userId: user.id, workspaceId: workspace.id, role: "OWNER" } });
        return { user, workspace };
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") throw Errors.emailTaken();
      throw err;
    }
  }

  /** Returns the user and their default workspace, or throws invalid credentials. */
  async login(input: z.infer<typeof loginSchema>) {
    const user = await this.db.user.findUnique({ where: { email: input.email } });
    if (!user) {
      await burnPasswordCheck(input.password);
      throw Errors.invalidCredentials();
    }
    if (!(await verifyPassword(user.passwordHash, input.password))) throw Errors.invalidCredentials();

    if (needsRehash(user.passwordHash)) {
      await this.db.user.update({ where: { id: user.id }, data: { passwordHash: await hashPassword(input.password) } });
    }
    const membership = await this.db.membership.findFirst({
      where: { userId: user.id },
      orderBy: { createdAt: "asc" },
      include: { workspace: true },
    });
    if (!membership) throw Errors.invalidCredentials();
    return { user, workspace: membership.workspace };
  }
}
