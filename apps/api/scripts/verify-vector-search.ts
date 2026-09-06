// Phase 23 — vector search mechanics: embedding determinism, cosine
// similarity ranking, topK limiting, documentType/tag filtering, and
// cross-asset isolation. Mostly Part B (in-process against the real
// Postgres/pgvector instance, no HTTP) since KnowledgeDocument has no FK
// to Asset (soft reference, same as every other audit table in this
// schema) — a throwaway assetId string works fine and needs no real
// Asset/Account/mock GitHub server. One small Part A HTTP block covers
// topK enforcement through the real route + ownership.
import { randomUUID } from 'node:crypto';
import { prisma } from '../src/db/prisma.js';
import { redis } from '../src/cache/redis.js';
import { userRepository } from '../src/repositories/user.repository.js';
import { categoryRepository } from '../src/repositories/category.repository.js';
import { assetRepository } from '../src/repositories/asset.repository.js';
import {
  api,
  createAdminAndCategory,
  createChecker,
  registerAndLogin,
} from './lib/verify-helpers.js';
import { embeddingService } from '../src/ai/embeddings/index.js';
import { knowledgeStore, knowledgeRepository } from '../src/ai/knowledge/index.js';
import { retrievalService } from '../src/ai/retrieval/index.js';

async function main(): Promise<void> {
  const { check, state } = createChecker();
  const stamp = Date.now();
  const assetA = `verify-vector-search-asset-a-${stamp}`;
  const assetB = `verify-vector-search-asset-b-${stamp}`;

  try {
    console.log('Part B — in-process embedding + vector search mechanics');

    console.log('1. embedding determinism — same text embeds to the same vector');
    const first = await embeddingService.embed(
      'public S3 bucket allows unauthenticated read access',
    );
    const second = await embeddingService.embed(
      'public S3 bucket allows unauthenticated read access',
    );
    check(
      'vector width is 1536 both times',
      first.embedding.length === 1536 && second.embedding.length === 1536,
    );
    check(
      'identical text produces an identical vector',
      first.embedding.every((value, i) => value === second.embedding[i]),
    );

    console.log('2. embedding distinguishes unrelated text (cosine similarity ordering)');
    const risky = await embeddingService.embed(
      'the S3 bucket is publicly exposed with no encryption',
    );
    const nearDuplicate = await embeddingService.embed(
      'this S3 bucket is publicly exposed and unencrypted',
    );
    const unrelated = await embeddingService.embed('the cafeteria menu changes every Tuesday');
    const simNearDuplicate = cosineSimilarity(risky.embedding, nearDuplicate.embedding);
    const simUnrelated = cosineSimilarity(risky.embedding, unrelated.embedding);
    check(
      'near-duplicate text is more similar than unrelated text',
      simNearDuplicate > simUnrelated,
      `near=${simNearDuplicate.toFixed(3)} unrelated=${simUnrelated.toFixed(3)}`,
    );

    console.log('3. index three documents under assetA, search ranks the closest match first');
    await knowledgeStore.indexDocuments([
      {
        assetId: assetA,
        agent: 'test-agent',
        documentType: 'FINDING',
        text: 'Public S3 bucket exposes customer data with no access controls.',
        tags: ['storage', 'critical'],
        sourceId: `${assetA}:doc-1`,
      },
      {
        assetId: assetA,
        agent: 'test-agent',
        documentType: 'RECOMMENDATION',
        text: 'Rotate the database credentials that were committed to source control.',
        tags: ['secrets'],
        sourceId: `${assetA}:doc-2`,
      },
      {
        assetId: assetA,
        agent: 'test-agent',
        documentType: 'COMPLIANCE_RESULT',
        text: 'CIS 1.4 control failed: root account has no MFA enabled.',
        tags: ['compliance'],
        sourceId: `${assetA}:doc-3`,
      },
    ]);

    const bucketSearch = await retrievalService.search({
      question: 'is any storage bucket publicly accessible',
      assetId: assetA,
      topK: 3,
    });
    check('search returns all 3 documents for topK=3', bucketSearch.documents.length === 3);
    check(
      'the S3 bucket finding ranks first for a storage-exposure question',
      bucketSearch.documents[0]?.text.includes('Public S3 bucket'),
      bucketSearch.documents[0]?.text,
    );
    check(
      'results are ordered by descending score',
      bucketSearch.documents.every(
        (doc, i) => i === 0 || bucketSearch.documents[i - 1].score >= doc.score,
      ),
    );
    check(
      'embeddingVersion is reported on the result',
      typeof bucketSearch.embeddingVersion === 'string',
    );
    check('latencyMs is reported and non-negative', bucketSearch.latencyMs >= 0);

    console.log('4. topK limiting — topK=1 returns exactly one document');
    const limited = await retrievalService.search({
      question: 'security issue',
      assetId: assetA,
      topK: 1,
    });
    check(
      'topK=1 returns exactly 1 document',
      limited.documents.length === 1,
      `${limited.documents.length}`,
    );

    console.log('5. documentType filter isolates results');
    const complianceOnly = await retrievalService.search({
      question: 'security issue',
      assetId: assetA,
      documentTypes: ['COMPLIANCE_RESULT'],
      topK: 10,
    });
    check(
      'documentType filter returns only COMPLIANCE_RESULT',
      complianceOnly.documents.length === 1 &&
        complianceOnly.documents[0]?.documentType === 'COMPLIANCE_RESULT',
      JSON.stringify(complianceOnly.documents.map((d) => d.documentType)),
    );

    console.log('6. tag filter — overlap match works');
    const tagFiltered = await knowledgeRepository.search(
      (await embeddingService.embed('anything')).embedding,
      { assetId: assetA, tags: ['secrets'] },
      10,
    );
    check(
      'tag filter returns only the tagged document',
      tagFiltered.length === 1 && tagFiltered[0]?.tags.includes('secrets'),
      JSON.stringify(tagFiltered.map((d) => d.tags)),
    );

    console.log('7. cross-asset isolation — assetB never sees assetA documents');
    await knowledgeStore.indexDocument({
      assetId: assetB,
      agent: 'test-agent',
      documentType: 'FINDING',
      text: 'A completely unrelated finding on a different asset.',
      sourceId: `${assetB}:doc-1`,
    });
    const crossAssetSearch = await retrievalService.search({
      question: 'is any storage bucket publicly accessible',
      assetId: assetB,
      topK: 10,
    });
    check(
      'assetB search never returns an assetA document',
      crossAssetSearch.documents.every((doc) => !doc.text.includes('Public S3 bucket')),
      JSON.stringify(crossAssetSearch.documents.map((d) => d.text)),
    );

    console.log(
      '8. upsert-by-sourceId — re-indexing the same sourceId updates in place, not a duplicate',
    );
    const beforeCount = (await knowledgeRepository.listByAsset(assetA)).length;
    await knowledgeStore.indexDocument({
      assetId: assetA,
      agent: 'test-agent',
      documentType: 'FINDING',
      text: 'Public S3 bucket exposes customer data with no access controls. UPDATED.',
      sourceId: `${assetA}:doc-1`,
    });
    const afterDocs = await knowledgeRepository.listByAsset(assetA);
    check(
      'document count unchanged after re-indexing same sourceId',
      afterDocs.length === beforeCount,
      `${afterDocs.length} vs ${beforeCount}`,
    );
    check(
      'document text was updated in place',
      afterDocs.some((doc) => doc.text.includes('UPDATED')),
    );

    console.log('\nPart A — HTTP surface: topK enforcement + ownership through the real route');
    const { admin, categoryId } = await createAdminAndCategory('vector-search');
    const owner = await registerAndLogin(`verify-vector-search-owner-${stamp}@example.test`);
    const httpAssetRes = await api<{ id: string }>('POST', '/assets', owner.accessToken, {
      categoryId,
      name: `verify-vector-search-http-asset-${stamp}`,
    });
    const httpAssetId = httpAssetRes.body.id;

    for (let i = 0; i < 5; i += 1) {
      await api('POST', '/knowledge/index', owner.accessToken, {
        assetId: httpAssetId,
        agent: 'test-agent',
        documentType: 'FINDING',
        text: `Finding number ${i} about a security issue in resource ${randomUUID()}.`,
      });
    }
    const httpSearchRes = await api<{ documents: unknown[] }>(
      'POST',
      '/knowledge/search',
      owner.accessToken,
      {
        question: 'security issue',
        assetId: httpAssetId,
        topK: 2,
      },
    );
    check('HTTP search status 200', httpSearchRes.status === 200, `${httpSearchRes.status}`);
    check(
      'HTTP search respects topK=2',
      httpSearchRes.body.documents.length === 2,
      `${httpSearchRes.body.documents.length}`,
    );

    await knowledgeRepository.deleteByAsset(httpAssetId);
    await assetRepository.delete(httpAssetId);
    await categoryRepository.delete(categoryId);
    await userRepository.delete(admin.id);
    await userRepository.delete(owner.id);

    if (state.failed) {
      console.error('\nOne or more vector search checks FAILED.');
    } else {
      console.log('\nAll vector search checks passed.');
    }
  } finally {
    await knowledgeRepository.deleteByAsset(assetA);
    await knowledgeRepository.deleteByAsset(assetB);
    await redis.quit().catch(() => undefined);
    await prisma.$disconnect();
  }

  if (state.failed) {
    process.exitCode = 1;
  }
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

void main();
