-- CreateEnum
CREATE TYPE "AgentPlanStatus" AS ENUM ('RUNNING', 'COMPLETED', 'FAILED');

-- CreateTable
CREATE TABLE "AgentPlanExecution" (
    "id" TEXT NOT NULL,
    "requestType" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "status" "AgentPlanStatus" NOT NULL,
    "summary" JSONB,
    "error" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "durationMs" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentPlanExecution_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AgentPlanExecution_assetId_idx" ON "AgentPlanExecution"("assetId");

-- CreateIndex
CREATE INDEX "AgentPlanExecution_requestType_idx" ON "AgentPlanExecution"("requestType");

-- CreateIndex
CREATE INDEX "AgentPlanExecution_status_idx" ON "AgentPlanExecution"("status");
