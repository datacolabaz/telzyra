-- Platform-initiated data deletion requests (Meta Data Deletion Request Callback). Additive only.
CREATE TABLE "data_deletion_requests" (
    "id" UUID NOT NULL,
    "confirmationCode" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "subjectHash" TEXT NOT NULL,
    "connectionsAffected" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'RECEIVED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "data_deletion_requests_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "data_deletion_requests_confirmationCode_key" ON "data_deletion_requests"("confirmationCode");
CREATE INDEX "data_deletion_requests_subjectHash_idx" ON "data_deletion_requests"("subjectHash");
