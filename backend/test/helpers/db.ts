import { prisma } from "../../src/db/client.js";

/** Empties every table between tests (order-independent thanks to CASCADE). */
export async function resetDb() {
  await prisma.$executeRawUnsafe(
    `TRUNCATE users, workspaces, memberships, sessions, audit_logs, connections, credentials,
     oauth_states, webhook_subscriptions, webhook_events, workflows, workflow_executions, trigger_states RESTART IDENTITY CASCADE`,
  );
}

export { prisma };
