-- AlterEnum
ALTER TYPE "KnowledgeDocumentType" ADD VALUE 'EPISODE';

-- DropIndex
DROP INDEX "KnowledgeDocument_embedding_idx";
