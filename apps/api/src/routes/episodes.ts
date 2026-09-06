import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { episodicMemoryFoundation } from '../ai/episodic-memory/index.js';
import {
  computeAgentReliability,
  computeToolReliability,
} from '../ai/episodic-memory/episode.relevance.js';
import { formatValidationErrors } from './shared/validation.js';

const searchBodySchema = z.object({
  goal: z.string().min(1),
  assetId: z.string().min(1).optional(),
  topK: z.number().int().positive().max(20).optional(),
});

const idParamsSchema = z.object({ id: z.string().min(1) });

const historyQuerySchema = z.object({
  assetId: z.string().min(1),
  limit: z.coerce.number().int().positive().max(100).optional(),
});

const statisticsQuerySchema = z.object({
  assetId: z.string().min(1),
});

// Long-Term Episodic Memory endpoints (Phase 30) — additive alongside
// every prior AI entry point. Search/history/statistics all read
// episodes that were captured automatically by
// ai/episodic-memory/index.js's captureEpisodeSafely (wired into every
// completed-execution site); there is no manual "create episode" route,
// matching Phase 23's Knowledge Store precedent (automatic indexing, no
// manual index route as the primary path).
export function episodesRoutes(app: FastifyInstance): void {
  const authenticate = {
    preHandler: (request: FastifyRequest, reply: FastifyReply) => app.authenticate(request, reply),
  };

  app.post('/ai/episodes/search', authenticate, async (request, reply) => {
    const parsed = searchBodySchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return formatValidationErrors(parsed.error);
    }
    try {
      const matches = await episodicMemoryFoundation.search.search({
        goal: parsed.data.goal,
        assetId: parsed.data.assetId,
        topK: parsed.data.topK,
      });
      reply.code(200);
      return { matches };
    } catch (err) {
      app.log.error(err);
      reply.code(500);
      return { status: 'error', message: 'Internal server error' };
    }
  });

  app.get('/ai/episodes/history', authenticate, async (request, reply) => {
    const parsed = historyQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      reply.code(400);
      return formatValidationErrors(parsed.error);
    }
    const episodes = await episodicMemoryFoundation.store.getHistory(
      parsed.data.assetId,
      parsed.data.limit,
    );
    reply.code(200);
    return { episodes };
  });

  app.get('/ai/episodes/statistics', authenticate, async (request, reply) => {
    const parsed = statisticsQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      reply.code(400);
      return formatValidationErrors(parsed.error);
    }
    const episodes = await episodicMemoryFoundation.store.getHistory(parsed.data.assetId, 100);
    reply.code(200);
    return {
      episodeCount: episodes.length,
      agentReliability: computeAgentReliability(episodes),
      toolReliability: computeToolReliability(episodes),
    };
  });

  app.get('/ai/episodes/:id', authenticate, async (request, reply) => {
    const parsed = idParamsSchema.safeParse(request.params);
    if (!parsed.success) {
      reply.code(400);
      return formatValidationErrors(parsed.error);
    }
    const episode = await episodicMemoryFoundation.store.get(parsed.data.id);
    if (!episode) {
      reply.code(404);
      return { status: 'error', message: `no episode "${parsed.data.id}"` };
    }
    reply.code(200);
    return episode;
  });
}
