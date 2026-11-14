-- CreateEnum
CREATE TYPE "WorkflowStatus" AS ENUM ('DRAFT', 'ACTIVE', 'PAUSED');

-- CreateEnum
CREATE TYPE "ExecutionStatus" AS ENUM ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED');

-- AlterTable
ALTER TABLE "oauth_states" ADD COLUMN     "connectionId" UUID;

-- CreateTable
CREATE TABLE "workflows" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "status" "WorkflowStatus" NOT NULL DEFAULT 'DRAFT',
    "definition" JSONB NOT NULL,
    "triggerConnector" TEXT,
    "triggerKey" TEXT,
    "triggerConnectionId" UUID,
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workflows_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflow_executions" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "workflowId" UUID NOT NULL,
    "status" "ExecutionStatus" NOT NULL DEFAULT 'QUEUED',
    "source" TEXT NOT NULL,
    "triggerData" JSONB NOT NULL,
    "steps" JSONB NOT NULL DEFAULT '[]',
    "error" TEXT,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workflow_executions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "trigger_states" (
    "id" UUID NOT NULL,
    "workflowId" UUID NOT NULL,
    "cursor" JSONB,
    "lastPolledAt" TIMESTAMP(3),
    "lastError" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "trigger_states_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "workflows_workspaceId_idx" ON "workflows"("workspaceId");

-- CreateIndex
CREATE INDEX "workflows_triggerConnectionId_triggerKey_status_idx" ON "workflows"("triggerConnectionId", "triggerKey", "status");

-- CreateIndex
CREATE INDEX "workflow_executions_workflowId_createdAt_idx" ON "workflow_executions"("workflowId", "createdAt");

-- CreateIndex
CREATE INDEX "workflow_executions_workspaceId_createdAt_idx" ON "workflow_executions"("workspaceId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "trigger_states_workflowId_key" ON "trigger_states"("workflowId");

-- AddForeignKey
ALTER TABLE "workflows" ADD CONSTRAINT "workflows_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_executions" ADD CONSTRAINT "workflow_executions_workflowId_fkey" FOREIGN KEY ("workflowId") REFERENCES "workflows"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trigger_states" ADD CONSTRAINT "trigger_states_workflowId_fkey" FOREIGN KEY ("workflowId") REFERENCES "workflows"("id") ON DELETE CASCADE ON UPDATE CASCADE;
