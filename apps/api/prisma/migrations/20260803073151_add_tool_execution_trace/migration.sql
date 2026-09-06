-- The ivfflat index on KnowledgeDocument.embedding (Phase 23) was created
-- by raw SQL, not a Prisma schema declaration (Prisma has no schema-level
-- way to express `USING ivfflat (... vector_cosine_ops)`), so Prisma's
-- migration diff engine doesn't know it exists and generates a DropIndex
-- for it on every subsequent `prisma migrate dev` — intentionally
-- removed here to keep the real vector index. This will recur for any
-- future migration too; the fix each time is the same: delete the
-- generated `DROP INDEX "KnowledgeDocument_embedding_idx";` line.

-- CreateTable
CREATE TABLE "ToolExecutionTrace" (
    "id" TEXT NOT NULL,
    "toolName" TEXT NOT NULL,
    "agentId" TEXT,
    "arguments" JSONB NOT NULL,
    "success" BOOLEAN NOT NULL,
    "error" TEXT,
    "durationMs" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ToolExecutionTrace_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ToolExecutionTrace_toolName_idx" ON "ToolExecutionTrace"("toolName");

-- CreateIndex
CREATE INDEX "ToolExecutionTrace_agentId_idx" ON "ToolExecutionTrace"("agentId");
