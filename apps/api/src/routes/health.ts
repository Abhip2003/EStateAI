import type { FastifyInstance } from 'fastify';
import { checkDatabaseConnection } from '../db/prisma.js';
import { checkRedisConnection } from '../cache/redis.js';

export function healthRoutes(app: FastifyInstance): void {
  app.get('/health', () => {
    return { status: 'ok' };
  });

  app.get('/health/db', async (request, reply) => {
    const isConnected = await checkDatabaseConnection();

    if (!isConnected) {
      reply.code(503);
      return { status: 'error', database: 'disconnected' };
    }

    return { status: 'ok', database: 'connected' };
  });

  app.get('/health/redis', async (request, reply) => {
    const isConnected = await checkRedisConnection();

    if (!isConnected) {
      reply.code(503);
      return { status: 'error', redis: 'disconnected' };
    }

    return { status: 'ok', redis: 'connected' };
  });

  app.get('/health/ready', async (request, reply) => {
    const [isDbConnected, isRedisConnected] = await Promise.all([
      checkDatabaseConnection(),
      checkRedisConnection(),
    ]);

    const database = isDbConnected ? 'connected' : 'disconnected';
    const redis = isRedisConnected ? 'connected' : 'disconnected';

    if (!isDbConnected || !isRedisConnected) {
      reply.code(503);
      return { status: 'not_ready', database, redis };
    }

    return { status: 'ready', database, redis };
  });
}
