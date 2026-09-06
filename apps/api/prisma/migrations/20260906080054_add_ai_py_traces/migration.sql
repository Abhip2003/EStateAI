-- CreateEnum
CREATE TYPE "AiPyRunStatus" AS ENUM ('RUNNING', 'COMPLETED', 'PARTIAL', 'FAILED');

-- CreateTable
CREATE TABLE "AiPyRun" (
    "id" TEXT NOT NULL,
    "correlationId" TEXT NOT NULL,
    "agent" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "assetId" TEXT,
    "accountId" TEXT,
    "status" "AiPyRunStatus" NOT NULL DEFAULT 'RUNNING',
    "confidenceScore" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "durationMs" INTEGER NOT NULL DEFAULT 0,
    "llmCalls" INTEGER NOT NULL DEFAULT 0,
    "inputSummary" JSONB,
    "error" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "AiPyRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiPyTrace" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "ok" BOOLEAN NOT NULL,
    "durationMs" INTEGER NOT NULL DEFAULT 0,
    "detail" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiPyTrace_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AiPyRun_agent_idx" ON "AiPyRun"("agent");

-- CreateIndex
CREATE INDEX "AiPyRun_assetId_idx" ON "AiPyRun"("assetId");

-- CreateIndex
CREATE INDEX "AiPyRun_correlationId_idx" ON "AiPyRun"("correlationId");

-- CreateIndex
CREATE INDEX "AiPyRun_status_idx" ON "AiPyRun"("status");

-- CreateIndex
CREATE INDEX "AiPyTrace_runId_idx" ON "AiPyTrace"("runId");

-- CreateIndex
CREATE INDEX "AiPyTrace_kind_idx" ON "AiPyTrace"("kind");
