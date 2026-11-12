import { beforeEach, describe, expect, it } from "vitest";
import { forWorkspace, TenantViolationError } from "../../src/tenancy/scoped-db.js";
import { cipher } from "../../src/db/client.js";
import { prisma, resetDb } from "../helpers/db.js";

async function seedTenant(label: string) {
  const user = await prisma.user.create({ data: { email: `${label}@example.com`, name: label, passwordHash: "x" } });
  const workspace = await prisma.workspace.create({ data: { name: label, slug: `${label}-slug` } });
  await prisma.membership.create({ data: { userId: user.id, workspaceId: workspace.id, role: "OWNER" } });
  return { user, workspace };
}

describe("workspace-scoped data access", () => {
  let a: Awaited<ReturnType<typeof seedTenant>>;
  let b: Awaited<ReturnType<typeof seedTenant>>;
  let connectionId: string;

  beforeEach(async () => {
    await resetDb();
    a = await seedTenant("alpha");
    b = await seedTenant("beta");
    const conn = await forWorkspace(prisma, a.workspace.id).connection.create({
      data: { provider: "slack", authType: "OAUTH2", displayName: "Alpha Slack", externalAccountId: "T1", createdById: a.user.id },
    });
    connectionId = conn.id;
  });

  it("sets workspaceId automatically on create", async () => {
    const row = await prisma.connection.findUniqueOrThrow({ where: { id: connectionId } });
    expect(row.workspaceId).toBe(a.workspace.id);
  });

  it("hides another workspace's rows from every read", async () => {
    const dbB = forWorkspace(prisma, b.workspace.id);
    expect(await dbB.connection.findUnique({ where: { id: connectionId } })).toBeNull();
    expect(await dbB.connection.findFirst({ where: { provider: "slack" } })).toBeNull();
    expect(await dbB.connection.findMany()).toHaveLength(0);
    expect(await dbB.connection.count()).toBe(0);
    expect(await forWorkspace(prisma, a.workspace.id).connection.count()).toBe(1);
  });

  it("cannot update or delete another workspace's rows", async () => {
    const dbB = forWorkspace(prisma, b.workspace.id);
    await expect(dbB.connection.update({ where: { id: connectionId }, data: { displayName: "pwned" } })).rejects.toThrow();
    expect((await dbB.connection.updateMany({ data: { displayName: "pwned" } })).count).toBe(0);
    await expect(dbB.connection.delete({ where: { id: connectionId } })).rejects.toThrow();
    expect((await dbB.connection.deleteMany({})).count).toBe(0);

    const row = await prisma.connection.findUniqueOrThrow({ where: { id: connectionId } });
    expect(row.displayName).toBe("Alpha Slack");
  });

  it("rejects creating rows for another workspace", async () => {
    const dbB = forWorkspace(prisma, b.workspace.id);
    await expect(
      dbB.connection.create({
        data: { workspaceId: a.workspace.id, provider: "slack", authType: "OAUTH2", displayName: "x", createdById: b.user.id },
      }),
    ).rejects.toThrow(TenantViolationError);
  });

  it("encrypted credentials cannot be read under another workspace's AAD", async () => {
    const aad = `credential:${a.workspace.id}:${connectionId}`;
    const secret = cipher.encryptJson({ accessToken: "xoxb-secret" }, aad);
    await prisma.credential.create({ data: { connectionId, secret, keyVersion: cipher.currentVersion } });

    const stored = await prisma.credential.findUniqueOrThrow({ where: { connectionId } });
    expect(stored.secret).not.toContain("xoxb-secret");
    expect(cipher.decryptJson<{ accessToken: string }>(stored.secret, aad).accessToken).toBe("xoxb-secret");
    expect(() => cipher.decrypt(stored.secret, `credential:${b.workspace.id}:${connectionId}`)).toThrow();
  });
});
