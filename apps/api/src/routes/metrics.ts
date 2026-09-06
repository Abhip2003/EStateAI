import type { FastifyInstance } from 'fastify';
import { config } from '../config/env.js';
import { metricsRegistry } from '../observability/metrics.js';

export function metricsRoutes(app: FastifyInstance): void {
  app.get('/metrics', async (request, reply) => {
    if (!config.metrics.enabled) {
      reply.code(404);
      return { status: 'error', message: 'Metrics are disabled' };
    }

    reply.header('content-type', metricsRegistry.contentType);
    return metricsRegistry.metrics();
  });
}
