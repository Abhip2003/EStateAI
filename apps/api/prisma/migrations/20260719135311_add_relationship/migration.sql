-- CreateTable
CREATE TABLE "Relationship" (
    "id" TEXT NOT NULL,
    "fromResourceId" TEXT NOT NULL,
    "toResourceId" TEXT NOT NULL,
    "relationshipType" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Relationship_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Relationship_fromResourceId_idx" ON "Relationship"("fromResourceId");

-- CreateIndex
CREATE INDEX "Relationship_toResourceId_idx" ON "Relationship"("toResourceId");

-- CreateIndex
CREATE INDEX "Relationship_relationshipType_idx" ON "Relationship"("relationshipType");

-- CreateIndex
CREATE UNIQUE INDEX "Relationship_fromResourceId_toResourceId_relationshipType_key" ON "Relationship"("fromResourceId", "toResourceId", "relationshipType");
