-- Enable pgvector (Phase 23 — Knowledge Base / RAG). Requires the
-- pgvector/pgvector Postgres image; see docker-compose*.yml.
CREATE EXTENSION IF NOT EXISTS vector;

-- CreateEnum
CREATE TYPE "KnowledgeDocumentType" AS ENUM ('FINDING', 'RECOMMENDATION', 'REPORT', 'COMPLIANCE_RESULT', 'RISK_ASSESSMENT', 'DISCOVERY_SUMMARY');

-- CreateTable
CREATE TABLE "KnowledgeDocument" (
    "id" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "agent" TEXT NOT NULL,
    "documentType" "KnowledgeDocumentType" NOT NULL,
    "text" TEXT NOT NULL,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "embeddingVersion" TEXT NOT NULL,
    "embedding" vector(1536),
    "sourceId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KnowledgeDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RetrievalTrace" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT,
    "assetId" TEXT,
    "query" TEXT NOT NULL,
    "documentIds" TEXT[],
    "scores" DOUBLE PRECISION[],
    "latencyMs" INTEGER NOT NULL,
    "embeddingVersion" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RetrievalTrace_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "KnowledgeDocument_assetId_idx" ON "KnowledgeDocument"("assetId");

-- CreateIndex
CREATE INDEX "KnowledgeDocument_documentType_idx" ON "KnowledgeDocument"("documentType");

-- CreateIndex
CREATE INDEX "KnowledgeDocument_agent_idx" ON "KnowledgeDocument"("agent");

-- CreateIndex
CREATE INDEX "KnowledgeDocument_assetId_documentType_idx" ON "KnowledgeDocument"("assetId", "documentType");

-- CreateIndex
CREATE INDEX "RetrievalTrace_conversationId_idx" ON "RetrievalTrace"("conversationId");

-- CreateIndex
CREATE INDEX "RetrievalTrace_assetId_idx" ON "RetrievalTrace"("assetId");

-- Approximate nearest-neighbor index for cosine similarity search over
-- embeddings. ivfflat (not the newer hnsw) for broad pgvector-version
-- compatibility. `lists = 100` is a reasonable default for the dataset
-- sizes this project runs at; ivfflat needs data present to train well,
-- but works (just unindexed-scan-slow) on an empty/small table too, so
-- creating it up front in the migration is safe.
CREATE INDEX "KnowledgeDocument_embedding_idx" ON "KnowledgeDocument"
  USING ivfflat ("embedding" vector_cosine_ops) WITH (lists = 100);
