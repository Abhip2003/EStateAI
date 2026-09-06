-- CreateEnum
CREATE TYPE "PolicyResultStatus" AS ENUM ('PASS', 'FAIL', 'WARNING', 'NOT_APPLICABLE');

-- CreateTable
CREATE TABLE "Policy" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "provider" TEXT NOT NULL,
    "resourceType" TEXT NOT NULL,
    "severity" "FindingSeverity" NOT NULL,
    "conditions" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Policy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PolicyResult" (
    "id" TEXT NOT NULL,
    "policyId" TEXT NOT NULL,
    "resourceId" TEXT NOT NULL,
    "findingId" TEXT,
    "status" "PolicyResultStatus" NOT NULL,
    "reason" TEXT NOT NULL,
    "metadata" JSONB,
    "evaluatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PolicyResult_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Policy_code_key" ON "Policy"("code");

-- CreateIndex
CREATE INDEX "Policy_provider_idx" ON "Policy"("provider");

-- CreateIndex
CREATE INDEX "Policy_enabled_idx" ON "Policy"("enabled");

-- CreateIndex
CREATE INDEX "PolicyResult_resourceId_idx" ON "PolicyResult"("resourceId");

-- CreateIndex
CREATE INDEX "PolicyResult_policyId_idx" ON "PolicyResult"("policyId");

-- CreateIndex
CREATE INDEX "PolicyResult_status_idx" ON "PolicyResult"("status");

-- CreateIndex
CREATE UNIQUE INDEX "PolicyResult_policyId_resourceId_key" ON "PolicyResult"("policyId", "resourceId");
