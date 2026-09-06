import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { getOwnedAsset } from '../services/assets/ownership.js';
import { AssetNotFoundError } from '../services/assets/errors.js';
import { ForbiddenError } from '../services/auth/errors.js';
import { knowledgeStore } from '../ai/knowledge/index.js';
import { retrievalService } from '../ai/retrieval/index.js';
import { formatValidationErrors } from './shared/validation.js';

const documentTypeSchema = z.enum([
  'FINDING',
  'RECOMMENDATION',
  'REPORT',
  'COMPLIANCE_RESULT',
  'RISK_ASSESSMENT',
  'DISCOVERY_SUMMARY',
]);

const indexBodySchema = z.object({
  assetId: z.string().min(1),
  agent: z.string().min(1),
  documentType: documentTypeSchema,
  text: z.string().min(1),
  metadata: z.record(z.string(), z.unknown()).optional(),
  tags: z.array(z.string()).optional(),
  sourceId: z.string().min(1).optional(),
});

const searchBodySchema = z.object({
  question: z.string().min(1),
  assetId: z.string().min(1).optional(),
  documentTypes: z.array(documentTypeSchema).optional(),
  agent: z.string().min(1).optional(),
  tags: z.array(z.string()).optional(),
  topK: z.coerce.number().int().positive().max(50).optional(),
});

const documentParamsSchema = z.object({ id: z.string().min(1) });
const historyParamsSchema = z.object({ assetId: z.string().min(1) });
const historyQuerySchema = z.object({ documentType: documentTypeSchema.optional() });

function mapKnowledgeError(
  err: unknown,
): { code: number; body: { status: 'error'; message: string } } | null {
  if (err instanceof ForbiddenError) {
    return { code: 403, body: { status: 'error', message: err.message } };
  }
  if (err instanceof AssetNotFoundError) {
    return { code: 404, body: { status: 'error', message: err.message } };
  }
  return null;
}

// Long-Term Memory / RAG (Phase 23) — manual indexing/search API over the
// Knowledge Store + Retrieval Service. Automatic indexing (every
// Discovery/Risk/Compliance/Recommendation/Report completion) happens
// unconditionally via ai/shared/knowledge.indexing.ts — these routes are
// for direct/manual use (backfilling, ad-hoc search, inspection) and are
// distinct from the pre-existing `/knowledge/context` +
// `/knowledge/retrievers` routes in routes/knowledge.ts (Phase 7C
// KnowledgeService/ContextBuilder — untouched, unrelated system). Every
// route is ownership-checked the same way copilot-agent.ts is: a
// KnowledgeDocument/search result is never returned for an asset the
// caller doesn't own.
export function knowledgeRagRoutes(app: FastifyInstance): void {
  const authenticate = {
    preHandler: (request: FastifyRequest, reply: FastifyReply) => app.authenticate(request, reply),
  };

  app.post('/knowledge/index', authenticate, async (request, reply) => {
    const parsed = indexBodySchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return formatValidationErrors(parsed.error);
    }
    try {
      await getOwnedAsset(parsed.data.assetId, request.user);
      const document = await knowledgeStore.indexDocument(parsed.data);
      reply.code(201);
      return document;
    } catch (err) {
      const mapped = mapKnowledgeError(err);
      if (mapped) {
        reply.code(mapped.code);
        return mapped.body;
      }
      app.log.error(err);
      reply.code(500);
      return { status: 'error', message: 'Internal server error' };
    }
  });

  app.post('/knowledge/search', authenticate, async (request, reply) => {
    const parsed = searchBodySchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return formatValidationErrors(parsed.error);
    }
    try {
      if (parsed.data.assetId) {
        await getOwnedAsset(parsed.data.assetId, request.user);
      }
      const result = await retrievalService.search(parsed.data);
      reply.code(200);
      return result;
    } catch (err) {
      const mapped = mapKnowledgeError(err);
      if (mapped) {
        reply.code(mapped.code);
        return mapped.body;
      }
      app.log.error(err);
      reply.code(500);
      return { status: 'error', message: 'Internal server error' };
    }
  });

  app.get('/knowledge/document/:id', authenticate, async (request, reply) => {
    const parsed = documentParamsSchema.safeParse(request.params);
    if (!parsed.success) {
      reply.code(400);
      return formatValidationErrors(parsed.error);
    }
    const document = await knowledgeStore.getDocument(parsed.data.id);
    if (!document) {
      reply.code(404);
      return { status: 'error', message: 'Document not found' };
    }
    try {
      await getOwnedAsset(document.assetId, request.user);
    } catch (err) {
      const mapped = mapKnowledgeError(err);
      if (mapped) {
        reply.code(mapped.code);
        return mapped.body;
      }
      throw err;
    }
    reply.code(200);
    return document;
  });

  app.get('/knowledge/history/:assetId', authenticate, async (request, reply) => {
    const paramsParsed = historyParamsSchema.safeParse(request.params);
    const queryParsed = historyQuerySchema.safeParse(request.query);
    if (!paramsParsed.success) {
      reply.code(400);
      return formatValidationErrors(paramsParsed.error);
    }
    if (!queryParsed.success) {
      reply.code(400);
      return formatValidationErrors(queryParsed.error);
    }
    try {
      await getOwnedAsset(paramsParsed.data.assetId, request.user);
      const history = await knowledgeStore.getHistory(
        paramsParsed.data.assetId,
        queryParsed.data.documentType,
      );
      reply.code(200);
      return { assetId: paramsParsed.data.assetId, documents: history };
    } catch (err) {
      const mapped = mapKnowledgeError(err);
      if (mapped) {
        reply.code(mapped.code);
        return mapped.body;
      }
      app.log.error(err);
      reply.code(500);
      return { status: 'error', message: 'Internal server error' };
    }
  });
}
