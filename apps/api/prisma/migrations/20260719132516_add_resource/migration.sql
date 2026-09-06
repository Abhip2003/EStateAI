-- CreateTable
CREATE TABLE "Resource" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerResourceId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "resourceType" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "description" TEXT,
    "externalUrl" TEXT,
    "metadata" JSONB,
    "hash" TEXT NOT NULL,
    "firstSeen" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeen" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Resource_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Resource_provider_idx" ON "Resource"("provider");

-- CreateIndex
CREATE INDEX "Resource_resourceType_idx" ON "Resource"("resourceType");

-- CreateIndex
CREATE INDEX "Resource_assetId_idx" ON "Resource"("assetId");

-- CreateIndex
CREATE UNIQUE INDEX "Resource_provider_providerResourceId_key" ON "Resource"("provider", "providerResourceId");
