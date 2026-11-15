-- Inbound Webhook trigger: one secret URL per workflow. Additive only.
CREATE TABLE "workflow_hooks" (
    "id" UUID NOT NULL,
    "workflowId" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "tokenEnc" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rotatedAt" TIMESTAMP(3),

    CONSTRAINT "workflow_hooks_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "workflow_hooks_workflowId_key" ON "workflow_hooks"("workflowId");
CREATE UNIQUE INDEX "workflow_hooks_tokenHash_key" ON "workflow_hooks"("tokenHash");
CREATE INDEX "workflow_hooks_workspaceId_idx" ON "workflow_hooks"("workspaceId");

ALTER TABLE "workflow_hooks" ADD CONSTRAINT "workflow_hooks_workflowId_fkey" FOREIGN KEY ("workflowId") REFERENCES "workflows"("id") ON DELETE CASCADE ON UPDATE CASCADE;
