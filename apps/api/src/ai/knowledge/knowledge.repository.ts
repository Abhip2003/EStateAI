import { randomUUID } from 'node:crypto';
import { prisma } from '../../db/prisma.js';
import { Prisma } from '../../generated/prisma/client.js';
import type {
  IndexDocumentInput,
  KnowledgeDocumentRecord,
  KnowledgeDocumentType,
  KnowledgeSearchResult,
} from './knowledge.types.js';

// Raw-SQL data access for KnowledgeDocument. The `embedding` column is
// Postgres `vector(1536)` declared via Prisma's `Unsupported(...)` type
// (see schema.prisma) — Prisma's generated client has no typed field for
// Unsupported columns at all, so every read/write that touches
// `embedding` goes through `$queryRaw`/`$executeRaw` here rather than
// `prisma.knowledgeDocument.*`. Everything else about KnowledgeDocument
// (plain columns) could use the generated client, but the whole row is
// handled raw in this file so there's one code path, not two.
class KnowledgeRepository {
  // Upsert-by-sourceId: re-indexing the same Finding/Recommendation/etc.
  // (e.g. a re-run of an agent) updates the existing document in place
  // instead of accumulating duplicates, matching the "no manual
  // indexing, automatic on every completion" requirement — repeated
  // automatic indexing must be idempotent.
  async upsert(
    input: IndexDocumentInput,
    embedding: number[],
    embeddingVersion: string,
  ): Promise<KnowledgeDocumentRecord> {
    const vectorLiteral = toVectorLiteral(embedding);
    const metadata = JSON.stringify(input.metadata ?? {});
    const tags = input.tags ?? [];

    const existing = input.sourceId
      ? await prisma.$queryRaw<{ id: string }[]>`
          SELECT id FROM "KnowledgeDocument"
          WHERE "sourceId" = ${input.sourceId} AND agent = ${input.agent}
          LIMIT 1
        `
      : [];

    const id = existing[0]?.id;

    if (id) {
      await prisma.$executeRaw`
        UPDATE "KnowledgeDocument"
        SET "assetId" = ${input.assetId},
            "documentType" = ${input.documentType}::"KnowledgeDocumentType",
            text = ${input.text},
            metadata = ${metadata}::jsonb,
            tags = ${tags},
            "embeddingVersion" = ${embeddingVersion},
            embedding = ${vectorLiteral}::vector,
            "updatedAt" = now()
        WHERE id = ${id}
      `;
      return this.getById(id) as Promise<KnowledgeDocumentRecord>;
    }

    const rows = await prisma.$queryRaw<{ id: string }[]>`
      INSERT INTO "KnowledgeDocument"
        (id, "assetId", agent, "documentType", text, metadata, tags, "embeddingVersion", embedding, "sourceId", "updatedAt")
      VALUES
        (${randomUUID()}, ${input.assetId}, ${input.agent}, ${input.documentType}::"KnowledgeDocumentType",
         ${input.text}, ${metadata}::jsonb, ${tags}, ${embeddingVersion}, ${vectorLiteral}::vector,
         ${input.sourceId ?? null}, now())
      RETURNING id
    `;
    return this.getById(rows[0].id) as Promise<KnowledgeDocumentRecord>;
  }

  async getById(id: string): Promise<KnowledgeDocumentRecord | null> {
    const rows = await prisma.$queryRaw<RawRow[]>`
      SELECT id, "assetId", agent, "documentType", text, metadata, tags,
             "embeddingVersion", "sourceId", "createdAt", "updatedAt"
      FROM "KnowledgeDocument"
      WHERE id = ${id}
    `;
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async listByAsset(
    assetId: string,
    documentType?: KnowledgeDocumentType,
  ): Promise<KnowledgeDocumentRecord[]> {
    const rows = documentType
      ? await prisma.$queryRaw<RawRow[]>`
          SELECT id, "assetId", agent, "documentType", text, metadata, tags,
                 "embeddingVersion", "sourceId", "createdAt", "updatedAt"
          FROM "KnowledgeDocument"
          WHERE "assetId" = ${assetId} AND "documentType" = ${documentType}::"KnowledgeDocumentType"
          ORDER BY "createdAt" DESC
        `
      : await prisma.$queryRaw<RawRow[]>`
          SELECT id, "assetId", agent, "documentType", text, metadata, tags,
                 "embeddingVersion", "sourceId", "createdAt", "updatedAt"
          FROM "KnowledgeDocument"
          WHERE "assetId" = ${assetId}
          ORDER BY "createdAt" DESC
        `;
    return rows.map(toRecord);
  }

  // Cosine-similarity nearest-neighbor search (`<=>` is pgvector's cosine
  // distance operator; `1 - distance` converts it to a similarity score
  // in [0, 1] so higher is always "more relevant", matching how every
  // other score in this codebase — riskScore, confidence — is oriented).
  async search(
    embedding: number[],
    filters: {
      assetId?: string;
      documentTypes?: KnowledgeDocumentType[];
      agent?: string;
      tags?: string[];
    },
    topK: number,
  ): Promise<KnowledgeSearchResult[]> {
    const vectorLiteral = toVectorLiteral(embedding);
    const conditions: Prisma.Sql[] = [Prisma.sql`embedding IS NOT NULL`];

    if (filters.assetId) conditions.push(Prisma.sql`"assetId" = ${filters.assetId}`);
    if (filters.agent) conditions.push(Prisma.sql`agent = ${filters.agent}`);
    if (filters.documentTypes && filters.documentTypes.length > 0) {
      conditions.push(
        Prisma.sql`"documentType" = ANY(${filters.documentTypes}::"KnowledgeDocumentType"[])`,
      );
    }
    if (filters.tags && filters.tags.length > 0) {
      conditions.push(Prisma.sql`tags && ${filters.tags}::text[]`);
    }

    const whereClause = Prisma.join(conditions, ' AND ');

    const rows = await prisma.$queryRaw<(RawRow & { score: number })[]>`
      SELECT id, "assetId", agent, "documentType", text, metadata, tags,
             "embeddingVersion", "sourceId", "createdAt", "updatedAt",
             1 - (embedding <=> ${vectorLiteral}::vector) AS score
      FROM "KnowledgeDocument"
      WHERE ${whereClause}
      ORDER BY embedding <=> ${vectorLiteral}::vector
      LIMIT ${topK}
    `;
    return rows.map((row) => ({ ...toRecord(row), score: Number(row.score) }));
  }

  // Prisma's generated client (not raw SQL) is fine for a plain delete —
  // no `embedding` column involved, and Prisma auto-drops the pgvector
  // column along with the row like any other.
  async deleteByAsset(assetId: string): Promise<number> {
    const result =
      await prisma.$executeRaw`DELETE FROM "KnowledgeDocument" WHERE "assetId" = ${assetId}`;
    return Number(result);
  }
}

interface RawRow {
  id: string;
  assetId: string;
  agent: string;
  documentType: KnowledgeDocumentType;
  text: string;
  metadata: unknown;
  tags: string[];
  embeddingVersion: string;
  sourceId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

function toRecord(row: RawRow): KnowledgeDocumentRecord {
  return {
    id: row.id,
    assetId: row.assetId,
    agent: row.agent,
    documentType: row.documentType,
    text: row.text,
    metadata: (row.metadata as Record<string, unknown>) ?? {},
    tags: row.tags ?? [],
    embeddingVersion: row.embeddingVersion,
    sourceId: row.sourceId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toVectorLiteral(embedding: number[]): string {
  return `[${embedding.join(',')}]`;
}

export const knowledgeRepository = new KnowledgeRepository();
